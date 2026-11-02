/**
 * Turns Work changes into `work.changed` push frames.
 *
 * Invalidate-not-delta: a frame names the Works that moved, never an answer,
 * and the desktop re-pulls `work.list`. One Work settling, delivering and
 * retrying can change a dozen times in a second, so changes are gathered for a
 * short window and sent as one frame.
 *
 * Process-level on purpose. A Work outlives the session that started it, so the
 * frame carries no workspace and no session, is not appended to any session's
 * replay log, and is never forwarded to IM channels.
 */

import { PushMethods, type ServerPush, WORKSPACE_ANY } from "@taco-ai/protocol";
import { makePushFrame } from "./push.ts";

/** Longest a change waits before it is announced. */
export const WORK_PUSH_COALESCE_MS = 100;

/** A single frame never names more Works than this; the rest ride the next one. */
const MAX_IDS_PER_FRAME = 200;

export class WorkPushAdapter {
    private readonly pending = new Set<string>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closed = false;

    constructor(
        private readonly instanceId: string,
        private readonly send: (frame: ServerPush) => void,
        private readonly windowMs: number = WORK_PUSH_COALESCE_MS,
    ) {}

    /** Record that a Work changed; the frame goes out when the window closes. */
    changed(workId: string): void {
        if (this.closed) return;
        this.pending.add(workId);
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => this.flush(), this.windowMs);
        // A pending announcement must not hold the process open.
        this.timer.unref?.();
    }

    /** Send what is gathered now. Exposed so shutdown and tests need no timer. */
    flush(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        while (this.pending.size > 0) {
            const batch = [...this.pending].slice(0, MAX_IDS_PER_FRAME);
            for (const id of batch) this.pending.delete(id);
            this.send(
                makePushFrame({
                    method: PushMethods.WorkChanged,
                    workspace: WORKSPACE_ANY,
                    params: { instanceId: this.instanceId, workIds: batch },
                }),
            );
        }
    }

    close(): void {
        this.closed = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
    }
}
