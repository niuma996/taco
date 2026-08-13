/**
 * Supplies ContextIndicator data from session.contextInfo.
 * Refreshes on session changes and token-affecting events. Compaction start
 * freezes the indicator; completion exposes a toast result before the parent
 * refreshes the post-compaction ratio. Missing sessions return null, and RPC
 * failures retain the previous indicator value.
 */

import type {
    CompactionFailureReason,
    SessionCompactionFinishedParams,
    SessionContextInfoResult,
} from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";

/** Event types that require a fresh indicator snapshot. */
const REFRESH_EVENT_TYPES = new Set<string>([
    "session_compact",
    "model_update",
    "agent_end",
    "turn_end",
    "settled",
]);

/** Watchdog window for a CompactionFinished frame. If the frame is lost
 *  (sidecar restart, push gap not recovered, bug), the input must not stay
 *  disabled forever. 40s is ~1.3× the 30s RPC compact timeout. */
const COMPACTION_WATCHDOG_MS = 40_000;

/** Latest compaction result for the parent to toast before refreshing. */
export type CompactionResultForToast =
    | {
          failed: true;
          durationMs: number;
          /** Machine-readable classification — drives the localized toast copy. */
          reason?: CompactionFailureReason;
          /** English-only diagnostic detail; rendered as-is when present. */
          failureMessage?: string;
      }
    | {
          failed: false;
          durationMs: number;
          summaryChars: number;
          tokensBefore: number;
          fromHook?: boolean;
      };

/** One-shot payload tagged with a monotonic id so the consumer can tell a new
 *  event from a stale effect re-run. */
export type TaggedCompactionResult = {
    id: number;
    result: CompactionResultForToast;
};

export interface UseSessionContextInfoApi {
    info: SessionContextInfoResult | null;
    loading: boolean;
    /** True while auto-compaction is in flight until session.compaction_finished arrives. */
    compacting: boolean;
    /** Most recent compaction result (success or failure), surfaced for the top-level toast. */
    lastCompactionFinished: TaggedCompactionResult | null;
    /** Dismiss the one-shot toast payload after the parent has consumed it. */
    clearCompactionToast: () => void;
    refresh: () => Promise<void>;
}

export function useSessionContextInfo(
    client: TacoClient,
    activeCwd: string | undefined,
    sessionId: string | undefined,
): UseSessionContextInfoApi {
    const [info, setInfo] = useState<SessionContextInfoResult | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [compacting, setCompacting] = useState<boolean>(false);
    const [lastCompactionFinished, setLastCompactionFinished] =
        useState<TaggedCompactionResult | null>(null);
    const nextResultIdRef = useRef(1);
    const watchdogRef = useRef<number | undefined>(undefined);

    const clearCompactionToast = useCallback(() => {
        setLastCompactionFinished(null);
    }, []);

    const stopWatchdog = useCallback(() => {
        if (watchdogRef.current !== undefined) {
            clearTimeout(watchdogRef.current);
            watchdogRef.current = undefined;
        }
    }, []);

    const startWatchdog = useCallback(() => {
        stopWatchdog();
        watchdogRef.current = window.setTimeout(() => {
            // Frame was lost (sidecar restart, push gap, bug). Recover input.
            setCompacting(false);
        }, COMPACTION_WATCHDOG_MS);
    }, [stopWatchdog]);

    const refresh = useCallback(async (): Promise<void> => {
        if (!activeCwd || !sessionId) {
            setInfo(null);
            return;
        }
        setLoading(true);
        try {
            const result = await client.sessionContextInfo(activeCwd, sessionId);
            setInfo(result);
        } catch (e) {
            // Indicator is auxiliary; RPC failures stay silent and retain the last value.
            console.error("[taco] sessionContextInfo failed:", e);
        } finally {
            setLoading(false);
        }
    }, [activeCwd, sessionId, client]);

    // Initial fetch on mount and on session change.
    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Drop compaction state when the target session changes.
    //
    // `compacting` is a single boolean for whichever session is active, and its
    // only clear path is that session's own CompactionFinished frame — which the
    // push listener discards for any other (workspace, session). Switching away
    // mid-compaction and back therefore used to strand the composer disabled
    // with no way to recover short of a reload. Resetting on identity change
    // also drops a stale toast payload from the previously-viewed session.
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — the identity pair IS the trigger; dropping it would reset only on mount and re-strand the composer
    useEffect(() => {
        setCompacting(false);
        setLastCompactionFinished(null);
        stopWatchdog();
    }, [activeCwd, sessionId, stopWatchdog]);

    // Clear compaction state when the sidecar for this workspace restarts.
    // A restart mid-compaction means the CompactionFinished frame will never
    // arrive for the old process, and the same (cwd, sessionId) after restart
    // would otherwise keep the input frozen.
    useEffect(() => {
        if (!activeCwd || !sessionId) return undefined;
        const off = client.onWorkspaceEpochChanged((workspace) => {
            if (workspace !== activeCwd) return;
            setCompacting(false);
            setLastCompactionFinished(null);
            stopWatchdog();
        });
        return off;
    }, [activeCwd, sessionId, client, stopWatchdog]);

    // Push events drive compaction state and incremental refresh.
    useEffect(() => {
        if (!activeCwd || !sessionId) return undefined;
        const off = client.onPush((frame) => {
            if (frame.workspace !== activeCwd || frame.session !== sessionId) return;

            // Compaction events use dedicated push methods, not the generic session.event channel.
            if (frame.method === PushMethods.CompactionStarted) {
                setCompacting(true);
                startWatchdog();
                return;
            }
            if (frame.method === PushMethods.CompactionFinished) {
                const params = frame.params as SessionCompactionFinishedParams;
                stopWatchdog();
                const result: CompactionResultForToast = params.failed
                    ? {
                          failed: true,
                          durationMs: params.durationMs,
                          ...(params.reason ? { reason: params.reason } : {}),
                          ...(params.failureMessage
                              ? { failureMessage: params.failureMessage }
                              : {}),
                      }
                    : {
                          failed: false,
                          durationMs: params.durationMs,
                          summaryChars: params.summaryChars,
                          tokensBefore: params.tokensBefore,
                          ...(params.fromHook !== undefined ? { fromHook: params.fromHook } : {}),
                      };
                setLastCompactionFinished({ id: nextResultIdRef.current++, result });
                setCompacting(false);
                // Defer refresh: the parent toasts first, then refreshes the post-compaction ratio.
                return;
            }

            // Generic session.event: refresh whenever REFRESH_EVENT_TYPES matches.
            if (frame.method !== "session.event") return;
            const params = frame.params as { event?: { type?: string } } | undefined;
            if (!params) return;
            if (params.event?.type && REFRESH_EVENT_TYPES.has(params.event.type)) {
                void refresh();
            }
        });
        return () => {
            off();
            stopWatchdog();
        };
    }, [activeCwd, sessionId, client, refresh, startWatchdog, stopWatchdog]);

    return {
        info,
        loading,
        compacting,
        lastCompactionFinished,
        clearCompactionToast,
        refresh,
    };
}
