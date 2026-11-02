/**
 * Turns Work changes into `work.changed` push frames.
 *
 * Invalidate-not-delta, like the other refresh pushes: the frame says only that
 * the overview moved, and the desktop re-pulls `work.list`. One Work settling,
 * delivering and retrying can change a dozen times in a second, so a burst is
 * folded into a single frame.
 *
 * Process-level on purpose. A Work outlives the session that started it, so the
 * frame carries no workspace and no session, is not appended to any session's
 * replay log, and is never forwarded to IM channels.
 */

import { PushMethods, type ServerPush, WORKSPACE_ANY } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { makePushFrame } from "./push.ts";

const log = createLogger("sidecar.work.push");

/** Longest a change waits before it is announced. */
export const WORK_PUSH_COALESCE_MS = 100;

export class WorkPushAdapter {
    private pending = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;

    constructor(
        private readonly send: (frame: ServerPush) => void | Promise<void>,
        private readonly windowMs: number = WORK_PUSH_COALESCE_MS,
    ) {}

    /** Record that a Work changed; the frame goes out when the window closes. */
    changed(): void {
        if (this.closed) return;
        this.pending = true;
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => this.flush(), this.windowMs);
        // A pending announcement must not hold the process open.
        this.timer.unref?.();
    }

    /** Send what is gathered now. Exposed so shutdown and tests need no timer. */
    flush(): void {
        this.clearTimer();
        if (!this.pending) return;
        this.pending = false;
        try {
            this.send(
                makePushFrame({
                    method: PushMethods.WorkChanged,
                    workspace: WORKSPACE_ANY,
                    params: {},
                }),
            )?.catch?.((e: unknown) => {
                // Fired from a timer: a rejected transport write must be logged,
                // not left as an unhandled rejection.
                log.error(`work.changed push failed: ${String(e)}`);
            });
        } catch (e) {
            log.error(`work.changed push threw: ${String(e)}`);
        }
    }

    close(): void {
        this.closed = true;
        this.clearTimer();
        this.pending = false;
    }

    private clearTimer(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
    }
}
