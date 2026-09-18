/**
 * CompactionPushAdapter — translates the compaction lifecycle into named push
 * frames (CompactionStarted / CompactionFinished). Extracted so SidecarServer
 * stays focused on routing + serialization.
 *
 * State machine: `taco_compaction_start` → CompactionStarted;
 * `taco_compaction_end` → CompactionFinished. Both are emitted by
 * CompactionController's paired lifecycle sink. pi 0.85 emits neither a
 * `session_before_compact` nor a `session_compact` event onto the bus this
 * adapter is fed from, so there is no pi-side pair to also accept.
 */

import { EventEmitter } from "node:events";
import {
    type CompactionFailureReason,
    PushMethods,
    type SessionCompactionFinishedParams,
    type SessionCompactionStartedParams,
    type SessionId,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { waitForEvent } from "../lib/async.ts";
import {
    COMPACTION_END_EVENT,
    COMPACTION_START_EVENT,
} from "../runtime/compaction/compactionController.ts";
import type { EmitPushFn } from "./pushTypes.ts";

interface InflightCompaction {
    tokensBefore: number;
    t0: number;
    fromHook?: boolean;
}

export class CompactionPushAdapter {
    /** key = `${cwd}\0${sessionId}` (avoids collisions when the same sessionId appears under multiple workspaces) */
    private readonly inflight = new Map<string, InflightCompaction>();
    private readonly events = new EventEmitter();
    private readonly emitPush: EmitPushFn;

    constructor(emitPush: EmitPushFn) {
        this.emitPush = emitPush;
    }

    /** Compaction event key. */
    private key(cwd: WorkspaceId, sessionId: SessionId): string {
        return `${cwd}\0${sessionId}`;
    }

    /** Whether the given (cwd, sessionId) is currently compacting. `true` iff `inflight.has(key)`. */
    isCompressing(cwd: WorkspaceId, sessionId: SessionId): boolean {
        return this.inflight.has(this.key(cwd, sessionId));
    }

    /**
     * Wait for the current compaction to finish. Returns immediately when
     * `isCompressing` is false (the common case). Otherwise subscribes to
     * `events` and resolves when `compactionFinished` fires. Resolves to
     * `false` on timeout so a prompt is never silently swallowed.
     */
    awaitCompactionEnd(cwd: WorkspaceId, sessionId: SessionId, timeoutMs = 1500): Promise<boolean> {
        const key = this.key(cwd, sessionId);
        if (!this.inflight.has(key)) {
            return Promise.resolve(true); // not busy, pass through
        }
        const wait = waitForEvent({
            timeoutMs,
            subscribe: (onDone) => {
                this.events.once(`compaction:done:${key}`, onDone);
                return () => this.events.off(`compaction:done:${key}`, onDone);
            },
        });
        return wait.promise;
    }

    /**
     * Handle a session.event. If it is compaction-related, assembles a push
     * frame and returns true. Returning false means it is NOT compaction-
     * related and the server should fall through to default routing.
     */
    handleSessionEvent(cwd: WorkspaceId, sessionId: SessionId, event: unknown): boolean {
        const evtType = (event as { type?: string } | undefined)?.type;

        // ── compaction start: record t0 + tokensBefore, emit CompactionStarted ──
        if (evtType === COMPACTION_START_EVENT) {
            const e = event as { tokensBefore?: number } | undefined;
            const tokensBefore = e?.tokensBefore ?? 0;
            this.inflight.set(this.key(cwd, sessionId), {
                tokensBefore,
                t0: Date.now(),
            });
            const started: SessionCompactionStartedParams = {
                cwd,
                sessionId,
                tokensBefore,
            };
            this.emitPush(PushMethods.CompactionStarted, cwd, sessionId, started);
            return true; // do not also emit the raw session.event — desktop would handle it twice
        }

        // ── compaction end: the unwind guarantee and the success signal ──
        // Emitted from CompactionController's `finally`, so it arrives on every
        // path out of harness.compact() — including the admission failures
        // (busy / nothing to compact) that never reach pi's drive and therefore
        // produce no pi event at all. `committed` is how success is reported;
        // there is no separate success event to wait for.
        if (evtType === COMPACTION_END_EVENT) {
            const start = this.inflight.get(this.key(cwd, sessionId));
            const e = event as
                | {
                      reason?: CompactionFailureReason;
                      committed?: { summaryChars: number; fromHook: boolean };
                  }
                | undefined;
            if (start) this.finish(cwd, sessionId, start, e?.committed, e?.reason);
            return true;
        }

        return false;
    }

    /**
     * Emit CompactionFinished + release any `awaitCompactionEnd` waiters.
     *
     * `failed` is derived from the absence of a committed summary. `committed`
     * is populated only when the controller read a compaction entry back off
     * the session, so its absence covers a throw, a hook decline, and an
     * admission failure alike — none of which produce a separate signal.
     *
     * `reason` is only written when the controller explicitly classified the
     * failure. An unclassified failure (no `reason` and no `committed`) keeps
     * the generic `failureMessage` so the client knows the classification
     * pipeline itself did not run, rather than misreporting it as
     * `harness_error`.
     */
    private finish(
        cwd: WorkspaceId,
        sessionId: SessionId,
        start: InflightCompaction | undefined,
        committed: { summaryChars: number; fromHook: boolean } | undefined,
        reason?: CompactionFailureReason,
    ): void {
        const key = this.key(cwd, sessionId);
        this.inflight.delete(key);
        const failed = committed === undefined;
        const finished: SessionCompactionFinishedParams = {
            cwd,
            sessionId,
            tokensBefore: start?.tokensBefore ?? 0,
            summaryChars: committed?.summaryChars ?? 0,
            durationMs: start ? Date.now() - start.t0 : 0,
            fromHook: committed?.fromHook,
            failed,
            ...(failed && reason ? { reason } : {}),
            ...(failed && !reason ? { failureMessage: "compaction did not commit a summary" } : {}),
        };
        this.events.emit(`compaction:done:${key}`);
        this.emitPush(PushMethods.CompactionFinished, cwd, sessionId, finished);
    }
}
