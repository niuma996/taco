/**
 * Normalizes sidecar pushes and stderr into reducer actions.
 * Session pushes are ordered by the sidecar's per-session `seq`: duplicates
 * are dropped, gaps are replayed through `session.events.get`, and bounded-log
 * expiry falls back to an authoritative snapshot. Listener refs still prevent
 * duplicate subscriptions under StrictMode.
 */

import type {
    ChannelStatusEntry,
    CommandPermissionRequest,
    PlanStateUpdatedParams,
    ServerPush,
    SubagentSpawnedPayload,
    TaskListMeta,
    TasksUpdatedParams,
} from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import type { SessionEventLike, SessionEventParams } from "../lib/chatUtils";
import { SessionPushProcessor, type SnapshotRecovery } from "../lib/sessionPushProcessor";
import { bannerSeverity, formatForBanner, parseLogLine } from "../lib/sidecarLogLine";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import { useStableCallback } from "../lib/useStableCallback";

export type SidecarAction =
    | { type: "EVENT"; cwd: string; sid: string; ev: SessionEventLike }
    | {
          type: "CHILD_MESSAGE_EVENT";
          cwd: string;
          sid: string;
          ev: SessionEventLike;
      }
    | {
          type: "SUBAGENT_SPAWNED";
          cwd: string;
          parentSessionId: string;
          parentToolCallId: string;
          subSessionId: string;
          agentType: string;
      }
    | { type: "ATTACHED"; cwd: string; sid: string }
    | {
          type: "COMMAND_PERMISSION_REQUESTED";
          cwd: string;
          sid: string;
          request: CommandPermissionRequest;
      }
    | { type: "REMOVE_SESSION"; cwd: string; sid: string }
    | { type: "SIDECAR_RESTARTED"; cwd: string }
    | { type: "ERROR"; cwd?: string; sid?: string; message: string }
    | {
          type: "ASKUSER_ANSWERED";
          cwd?: string;
          toolCallId: string;
          answers: Record<string, string | string[]>;
      }
    | {
          type: "TASKS_UPDATED";
          cwd: string;
          sid: string;
          active: TasksUpdatedParams["active"];
          history: TaskListMeta[];
      }
    | {
          type: "PLAN_STATE_UPDATED";
          cwd: string;
          sid: string;
          active: PlanStateUpdatedParams["active"];
          currentSlug: PlanStateUpdatedParams["currentSlug"];
      };

export interface UseSidecarStreamOpts {
    /** Receives normalized, cursor-ordered push frames. */
    onAction: (action: SidecarAction) => void;
    /** Rebuilds a session from authoritative pull snapshots after log retention expires. */
    onSnapshotRequired: (
        cwd: string,
        sid: string,
        sessionKind: "main" | "subagent",
    ) => Promise<SnapshotRecovery>;
    /**
     * Receives sidecar failures that warrant interrupting the user — `[error]`
     * lines plus unformatted stderr that looks like a crash.
     */
    onLogLine: (line: string) => void;
    /**
     * Receives `[warn]` lines. These are degradations, not failures (a skipped
     * corrupt file, a rebuilt cache, an extension override), so they must not
     * take over the global error banner. Unset means warns are dropped.
     */
    onWarningLine?: (line: string) => void;
    /** Receives `[taco:llm]` stderr lines when debug dumping is enabled. */
    onLlmDumpLine?: (line: string) => void;
    /**
     * Called when sidecar broadcasts `models.changed` (apiKeys / customProviders
     * were updated via settings.write). Desktop should re-pull
     * `providers.list` / `session.listModels` for the given workspace.
     */
    onModelsChanged?: (cwd: string) => void;
    /** Fired on every IM channel binding transition (QR shown, connected, ...). */
    onChannelStatusChanged?: (channel: ChannelStatusEntry) => void;
    /** Invalidate: a new IM conversation was routed by the sidecar. */
    onConversationsChanged?: () => void;
    /** Invalidate: an IM workspace policy was written. Carries `{channelId}`. */
    onImPolicyChanged?: (channelId: string) => void;
    /**
     * Pre-dispose notice: a policy change is about to interrupt live
     * conversations on `channelId`. Reserved for a future desktop warning —
     * the ImPolicyDialog already confirms before saving.
     */
    onImWorkspacesInvalidated?: (channelId: string) => void;
}

const LLM_DUMP_PREFIX = "[taco:llm]";

/** Normalizes a validated push frame into a workspace reducer action. */
function normalizePushFrame(p: ServerPush, onAction: (action: SidecarAction) => void): void {
    if (!p.workspace || !p.session) return;
    if (p.method === PushMethods.Attached) {
        onAction({ type: "ATTACHED", cwd: p.workspace, sid: p.session });
        return;
    }
    if (p.method === PushMethods.SessionDeleted) {
        // Reuse REMOVE_SESSION: filters the session from the local list and
        // clears activeSession if it was the one deleted.
        onAction({ type: "REMOVE_SESSION", cwd: p.workspace, sid: p.session });
        return;
    }
    if (p.method === PushMethods.Error) {
        const errMsg =
            (p.params as { error?: unknown } | undefined)?.error ?? "unknown sidecar error";
        const message = `[session.error] ${String(errMsg)}`;
        console.error("[taco] session.error", p.workspace, p.session, errMsg);
        onAction({ type: "ERROR", cwd: p.workspace, sid: p.session, message });
        return;
    }
    if (p.method === PushMethods.CommandPermissionRequested) {
        onAction({
            type: "COMMAND_PERMISSION_REQUESTED",
            cwd: p.workspace,
            sid: p.session,
            request: p.params as CommandPermissionRequest,
        });
        return;
    }
    if (p.method === PushMethods.SubagentSpawned) {
        const params = (p.params ?? {}) as Partial<SubagentSpawnedPayload>;
        const parentToolCallId =
            typeof params.parentToolCallId === "string" ? params.parentToolCallId : "";
        const subSessionId = typeof params.subSessionId === "string" ? params.subSessionId : "";
        const agentType = typeof params.agentType === "string" ? params.agentType : "";
        if (!parentToolCallId || !subSessionId) return;
        onAction({
            type: "SUBAGENT_SPAWNED",
            cwd: p.workspace,
            parentSessionId: p.session,
            parentToolCallId,
            subSessionId,
            agentType,
        });
        return;
    }

    let ev: SessionEventLike | undefined;
    if (p.method === PushMethods.Event) {
        ev = (p.params as SessionEventParams | undefined)?.event;
    } else if (p.method === PushMethods.ToolCallStart) {
        const params = (p.params ?? {}) as { toolCallId: string; toolName: string; args?: unknown };
        ev = {
            type: "tool_execution_start",
            toolCallId: params.toolCallId,
            toolName: params.toolName,
            args: params.args,
        };
    } else if (p.method === PushMethods.ToolCallUpdate) {
        const params = (p.params ?? {}) as { toolCallId: string; partialResult?: unknown };
        ev = {
            type: "tool_execution_update",
            toolCallId: params.toolCallId,
            partialResult: params.partialResult,
        };
    } else if (p.method === PushMethods.ToolCallEnd) {
        const params = (p.params ?? {}) as {
            toolCallId: string;
            toolName?: string;
            isError: boolean;
            result?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
        };
        ev = {
            type: "tool_execution_end",
            toolCallId: params.toolCallId,
            toolName: params.toolName,
            isError: params.isError,
            result: params.result,
        };
    } else if (p.method === PushMethods.TasksUpdated) {
        const params = (p.params ?? {}) as TasksUpdatedParams;
        onAction({
            type: "TASKS_UPDATED",
            cwd: p.workspace,
            sid: p.session,
            active: params.active,
            history: params.history,
        });
        return;
    } else if (p.method === PushMethods.PlanStateUpdated) {
        const params = (p.params ?? {}) as PlanStateUpdatedParams;
        onAction({
            type: "PLAN_STATE_UPDATED",
            cwd: p.workspace,
            sid: p.session,
            active: params.active,
            currentSlug: params.currentSlug,
        });
        return;
    }
    if (!ev) return;

    if (p.sessionKind === "subagent") {
        onAction({ type: "CHILD_MESSAGE_EVENT", cwd: p.workspace, sid: p.session, ev });
    } else {
        onAction({ type: "EVENT", cwd: p.workspace, sid: p.session, ev });
    }
}

/** Subscribes to sidecar pushes and serializes replay/recovery for each stream.
 *
 * Returns a `ready` promise alongside `clearCursors`; consumers that are
 * about to start the sidecar must `await ready` first so the stderr listener
 * is registered before the child process begins emitting. Without that gate,
 * a startup line written by the sidecar between `cmd.spawn()` and the
 * listener's `await listen(...)` returning would be dropped (Tauri's event
 * bus is fire-and-forget; there is no replay for late subscribers).
 *
 * Implementation note: `ready` is hoisted to module scope so the call order
 * between this hook and `useWorkspaces` doesn't matter — `useWorkspaces`
 * imports the same promise and awaits it before any `client.start`. Without
 * that, the only way to break the circular declaration order would be to
 * register `restoreSessionSnapshot` lazily via a ref. Module-scope is
 * simpler and the test (per-render isolation) doesn't apply here — both
 * hooks live in the same React tree instance. */
const READY_PROMISE: { promise: Promise<void>; resolve: () => void } = (() => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
})();

/** Resolves once `useSidecarStream`'s stderr listener is registered. Await
 * this from any code path that is about to call `client.start`. */
export const sidecarLogListenerReady: Promise<void> = READY_PROMISE.promise;

export function useSidecarStream(
    client: TacoClient,
    opts: UseSidecarStreamOpts,
): { clearCursors: () => void } {
    const onActionRef = useStableCallback(opts.onAction);
    const onSnapshotRequiredRef = useStableCallback(opts.onSnapshotRequired);
    const onLogLineRef = useStableCallback(opts.onLogLine);
    const onWarningLineRef = useStableCallback((line: string) => opts.onWarningLine?.(line));
    const onLlmDumpLineRef = useStableCallback((line: string) => opts.onLlmDumpLine?.(line));
    const onModelsChangedRef = useStableCallback((cwd: string) => opts.onModelsChanged?.(cwd));
    const onChannelStatusChangedRef = useStableCallback((channel: ChannelStatusEntry) =>
        opts.onChannelStatusChanged?.(channel),
    );
    const onConversationsChangedRef = useStableCallback(() => opts.onConversationsChanged?.());
    const onImPolicyChangedRef = useStableCallback((channelId: string) =>
        opts.onImPolicyChanged?.(channelId),
    );
    const onImWorkspacesInvalidatedRef = useStableCallback((channelId: string) =>
        opts.onImWorkspacesInvalidated?.(channelId),
    );

    const processorRef = useRef<SessionPushProcessor | undefined>(undefined);
    const processingRef = useRef<Promise<void>>(Promise.resolve());
    const logUnlistenRef = useRef<UnlistenFn | undefined>(undefined);
    const unsubscribePushRef = useRef<(() => void) | undefined>(undefined);
    // `ready` is created once on first render. The resolve callback is
    // captured by the effect that calls `await listen(...)`; once the
    // listener is registered it fires, and any `client.start` calls that
    // had `await ready` proceed.
    // No per-instance ready state needed — the module-level READY_PROMISE
    // resolves the first time the listener is registered. Subsequent
    // re-renders resolve immediately.

    if (!processorRef.current) {
        processorRef.current = new SessionPushProcessor({
            getEvents: (workspace, session, afterSeq) =>
                client.sessionEventsGet(workspace, session, afterSeq),
            deliver: (push) => normalizePushFrame(push, onActionRef),
            recoverSnapshot: (workspace, session, sessionKind) =>
                onSnapshotRequiredRef(workspace, session, sessionKind),
            reportError: (message, error) => {
                console.error("[taco] session push recovery", message, error);
                onLogLineRef(`[sidecar] ${message}`);
            },
        });
    }

    useEffect(() => {
        const unsubscribeEpoch = client.onWorkspaceEpochChanged((workspace) => {
            processorRef.current?.resetWorkspace(workspace);
            onActionRef({ type: "SIDECAR_RESTARTED", cwd: workspace });
        });
        unsubscribePushRef.current = client.onPush((push) => {
            // Workspace-level push (no session dimension) — bypass the
            // per-session processor and deliver directly.
            if (push.method === PushMethods.ModelsChanged) {
                if (push.workspace) onModelsChangedRef(push.workspace);
                return;
            }
            if (push.method === PushMethods.ChannelStatusChanged) {
                // Fanned out per workspace but process-level in meaning; the
                // handler is idempotent on channelId, so extra copies are safe.
                const params = push.params as { channel?: ChannelStatusEntry } | undefined;
                if (params?.channel) onChannelStatusChangedRef(params.channel);
                return;
            }
            if (push.method === PushMethods.ConversationsChanged) {
                // Same workspace-fanned-out shape as the other invalidate
                // pushes; the handler re-pulls channels.listConversations.
                onConversationsChangedRef();
                return;
            }
            if (push.method === PushMethods.ImPolicyChanged) {
                const params = push.params as { channelId?: string } | undefined;
                if (params?.channelId) onImPolicyChangedRef(params.channelId);
                return;
            }
            if (push.method === PushMethods.ImWorkspacesInvalidated) {
                // Workspace-dimensioned pre-dispose notice (fanned out per live
                // workspace on the channel). The dialog already confirms before
                // saving, so this only feeds a future desktop warning.
                const params = push.params as { channelId?: string } | undefined;
                if (params?.channelId) onImWorkspacesInvalidatedRef(params.channelId);
                return;
            }
            processingRef.current = processingRef.current
                .then(() => processorRef.current?.process(push))
                .catch((error) => {
                    console.error("[taco] push processing failed", error);
                    onLogLineRef(`[sidecar] push processing failed: ${String(error)}`);
                });
        });

        let cancelled = false;
        const init = async () => {
            const unlisten = await listen<{ line: string }>("sidecar-log", (event) => {
                const line = event.payload.line;
                if (line.startsWith(LLM_DUMP_PREFIX)) {
                    onLlmDumpLineRef(line);
                    return;
                }
                const parsed = parseLogLine(line);
                const severity = bannerSeverity(parsed);
                if (severity === "error") onLogLineRef(formatForBanner(parsed));
                else if (severity === "warn") onWarningLineRef(formatForBanner(parsed));
            });
            if (cancelled) {
                unlisten();
                return;
            }
            logUnlistenRef.current = unlisten;
            // Fire once. The second render's effect re-enters this branch
            // (the listener is already up) and resolves to a no-op because
            // the module-scope resolver is itself idempotent.
            READY_PROMISE.resolve();
        };
        void init();

        return () => {
            cancelled = true;
            unsubscribePushRef.current?.();
            unsubscribePushRef.current = undefined;
            unsubscribeEpoch();
            logUnlistenRef.current?.();
            logUnlistenRef.current = undefined;
        };
    }, [
        client,
        onActionRef,
        onChannelStatusChangedRef,
        onConversationsChangedRef,
        onImPolicyChangedRef,
        onImWorkspacesInvalidatedRef,
        onLlmDumpLineRef,
        onLogLineRef,
        onModelsChangedRef,
        onWarningLineRef,
    ]);

    const clearCursors = useCallback(() => processorRef.current?.clear(), []);
    return { clearCursors };
}
