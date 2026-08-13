/**
 * CompactionPushAdapter — translates compaction events into named push frames
 * (CompactionStarted / CompactionFinished). Extracted so SidecarServer stays
 * focused on routing + serialization.
 * State machine: session_before_compact → CompactionStarted; session_compact → CompactionFinished.
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
import { COMPACTION_END_EVENT, COMPACTION_START_EVENT } from "../runtime/compactionController.ts";
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
        // `COMPACTION_START_EVENT` is the load-bearing trigger, emitted by
        // CompactionController around every harness.compact(). pi's own
        // `session_before_compact` is also accepted, but never actually arrives:
        // it is dispatched via emitHook (type-specific handlers only) and so
        // never reaches the harness.subscribe stream that feeds session.event.
        if (evtType === COMPACTION_START_EVENT || evtType === "session_before_compact") {
            const e = event as
                | { tokensBefore?: number; preparation?: { tokensBefore?: number } }
                | undefined;
            const tokensBefore = e?.tokensBefore ?? e?.preparation?.tokensBefore ?? 0;
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

        // ── session_compact: the compaction committed — finish immediately ──
        if (evtType === "session_compact") {
            const key = this.key(cwd, sessionId);
            const entry = (
                event as { compactionEntry?: { summary?: string; fromHook?: boolean } } | undefined
            )?.compactionEntry;
            this.finish(cwd, sessionId, this.inflight.get(key), entry);
            return true;
        }

        // ── compaction end: the unwind guarantee ──
        // Emitted from CompactionController's `finally`, so it arrives on every
        // path out of harness.compact() — including hook cancel, summary
        // failure and busy, none of which emit `session_compact`. On the success
        // path the record is already gone and this is a no-op; otherwise it is
        // what keeps `inflight` from latching and freezing the desktop input.
        if (evtType === COMPACTION_END_EVENT) {
            const start = this.inflight.get(this.key(cwd, sessionId));
            const reason = (event as { reason?: CompactionFailureReason } | undefined)?.reason;
            if (start) this.finish(cwd, sessionId, start, undefined, reason);
            return true;
        }

        return false;
    }

    /**
     * Emit CompactionFinished + release any `awaitCompactionEnd` waiters.
     * `failed` is derived from the absence of a compaction entry: no entry
     * means `session_compact` never landed, i.e. the compaction did not commit.
     *
     * `reason` is only written when the controller explicitly classified the
     * failure. An unclassified failure (no `reason` and no `entry`) keeps the
     * generic `failureMessage` so the client knows the classification pipeline
     * itself did not run, rather than misreporting it as `harness_error`.
     */
    private finish(
        cwd: WorkspaceId,
        sessionId: SessionId,
        start: InflightCompaction | undefined,
        entry: { summary?: string; fromHook?: boolean } | undefined,
        reason?: CompactionFailureReason,
    ): void {
        const key = this.key(cwd, sessionId);
        this.inflight.delete(key);
        const failed = entry === undefined;
        const finished: SessionCompactionFinishedParams = {
            cwd,
            sessionId,
            tokensBefore: start?.tokensBefore ?? 0,
            summaryChars: entry?.summary?.length ?? 0,
            durationMs: start ? Date.now() - start.t0 : 0,
            fromHook: entry?.fromHook,
            failed,
            ...(failed && reason ? { reason } : {}),
            ...(failed && !reason ? { failureMessage: "compaction did not commit a summary" } : {}),
        };
        this.events.emit(`compaction:done:${key}`);
        this.emitPush(PushMethods.CompactionFinished, cwd, sessionId, finished);
    }
}
