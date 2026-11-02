/**
 * Follow the lane's queue so a scheduled fire that had to queue its prompt
 * learns what actually happened to it.
 *
 * A follow-up enqueued behind a running turn is not work done: the turn may
 * pick it up and answer it, a stop may clear the queue first, or the user may
 * cancel the entry. The scheduler records such a fire as a Work, and must not
 * call that Work finished on the strength of the enqueue alone.
 *
 * The watcher is created *before* the prompt is sent and buffers the session's
 * events, so nothing is missed however quickly the enqueue is consumed. It
 * resolves each awaited entry from the lane's own signals:
 *
 *  - the entry is placed into the transcript (`message_end` with its id); the
 *    run that placed it answers it, and its `run_end` says how;
 *  - a queue snapshot no longer lists it before that → it never ran;
 *  - the session detaches or is deleted → it never ran.
 */

import type { AgentMessage } from "../pi/types.ts";
import type { AttachedSession } from "./attachedSession.ts";

export type QueuedOutcome =
    /** Placed and answered; `message` is the run's final assistant message. */
    | { kind: "answered"; message: AgentMessage | null }
    /** Placed, then the run that carried it was stopped. */
    | { kind: "aborted" }
    /** Placed, then the run that carried it failed. */
    | { kind: "failed"; message: string }
    /** Left the queue without ever running. */
    | { kind: "dropped" };

export interface QueuedWatch {
    /** Resolves once the entry's fate is known. */
    wait(entryId: string): Promise<QueuedOutcome>;
    /** Stop buffering. Call when the turn did not queue anything. */
    stop(): void;
}

export interface LaneEvent {
    type?: string;
    entryId?: string;
    message?: AgentMessage;
    queues?: readonly { entryId: string }[];
    status?: string;
    error?: { message?: string };
}

/** What this module needs from a workspace runtime: its session lifecycle events. */
export interface SessionLifecycleSource {
    on(
        event: "session.detached" | "session.deleted",
        fn: (e: { sessionId: string }) => void,
    ): unknown;
    off(
        event: "session.detached" | "session.deleted",
        fn: (e: { sessionId: string }) => void,
    ): unknown;
}

export function createQueuedWatch(
    lifecycle: SessionLifecycleSource,
    attached: Pick<AttachedSession, "on" | "off">,
    sessionId: string,
): QueuedWatch {
    /** Entries placed into the transcript since the watcher started. */
    const placed = new Set<string>();
    /** Entries placed by the run currently in flight; answered at its end. */
    let inFlight = new Set<string>();
    let lastAssistant: AgentMessage | null = null;
    /** Latest queue snapshot; `undefined` until the first one arrives. */
    let queues: readonly { entryId: string }[] | undefined;
    let stopped = false;

    const waiters = new Map<string, (outcome: QueuedOutcome) => void>();

    const settle = (entryId: string, outcome: QueuedOutcome): void => {
        const resolve = waiters.get(entryId);
        if (!resolve) return;
        waiters.delete(entryId);
        resolve(outcome);
    };

    /** Decide an entry from the latest snapshot; no-op while still queued. */
    const judge = (entryId: string): void => {
        if (placed.has(entryId)) return;
        if (queues === undefined) return;
        if (!queues.some((q) => q.entryId === entryId)) {
            settle(entryId, { kind: "dropped" });
        }
    };

    const onEvent = (raw: unknown): void => {
        if (stopped) return;
        const event = raw as LaneEvent;
        switch (event.type) {
            case "message_end":
                if (event.message?.role === "assistant") lastAssistant = event.message;
                if (event.entryId !== undefined) {
                    placed.add(event.entryId);
                    inFlight.add(event.entryId);
                }
                return;
            case "queue_update":
                queues = event.queues ?? [];
                for (const entryId of waiters.keys()) judge(entryId);
                return;
            case "run_end": {
                const done = [...inFlight];
                inFlight = new Set();
                for (const entryId of done) {
                    // A placed entry is answered by the run that placed it,
                    // whether that run finished, stopped, or failed.
                    if (event.status === "completed") {
                        settle(entryId, { kind: "answered", message: lastAssistant });
                    } else if (event.status === "aborted") {
                        settle(entryId, { kind: "aborted" });
                    } else {
                        settle(entryId, {
                            kind: "failed",
                            message: event.error?.message ?? "run failed",
                        });
                    }
                }
                lastAssistant = null;
                return;
            }
        }
    };

    const onGone = (e: { sessionId: string }): void => {
        if (e.sessionId !== sessionId) return;
        for (const entryId of [...waiters.keys()]) settle(entryId, { kind: "dropped" });
    };

    attached.on("event", onEvent);
    lifecycle.on("session.detached", onGone);
    lifecycle.on("session.deleted", onGone);

    const stop = (): void => {
        if (stopped) return;
        stopped = true;
        attached.off("event", onEvent);
        lifecycle.off("session.detached", onGone);
        lifecycle.off("session.deleted", onGone);
        for (const entryId of [...waiters.keys()]) settle(entryId, { kind: "dropped" });
    };

    return {
        wait(entryId: string): Promise<QueuedOutcome> {
            if (stopped) return Promise.resolve({ kind: "dropped" });
            return new Promise<QueuedOutcome>((resolve) => {
                waiters.set(entryId, resolve);
                // The enqueue's own snapshot already contains the entry, so an
                // immediate judgement is safe: it covers an entry that was
                // cleared before this call.
                judge(entryId);
            });
        },
        stop,
    };
}
