/**
 * Lane steering-queue operations — enqueue (steer / followUp) and cancel.
 *
 * Split out of AttachedSession because the enqueue contract is a concern of its
 * own: pi's queue writes are unconditional, so "is there a run to consume this"
 * has to be decided here rather than by the caller.
 */

import { harnessContext } from "../lib/harnessContext.ts";
import { toHarnessError } from "./harnessErrors.ts";
import type { AgentLane, ImageContent } from "./pi/types.ts";

/**
 * Outcome of a steering enqueue.
 *
 * `idle` is not an error: pi's steer / followUp are pure inbox writes, so with
 * no active run the message would sit unconsumed until the next prompt. The
 * caller falls back to `session.prompt` instead of silently accumulating.
 */
export type SteerEnqueueResult = { mode: "queued"; entryId: string } | { mode: "idle" };

/** Normal-outcome kinds of pi's CancelQueuedResult. */
export type CancelQueuedKind = "cancelled" | "already_consumed" | "not_found";

/** Which queue an enqueue targets — see `enqueueLaneMessage`. */
export type QueueKind = "steer" | "followUp";

/**
 * Enqueue a message onto the lane's steer or followUp queue.
 *
 * `steer` is consumed at every tool-batch checkpoint (interrupt and redirect);
 * `followUp` only at a may-finish boundary (queue behind the current work). Both
 * require an active *run*: a compaction operation occupies the lane without
 * consuming either queue, which is why the guard tests `kind === "run"` and not
 * merely "an operation is present".
 *
 * The inspect-then-write pair is best-effort by nature — the run can end in the
 * window between the two calls. Callers handle that as the `idle` case reported
 * on the *next* attempt, not as a correctness bug here.
 */
export async function enqueueLaneMessage(
    lane: AgentLane,
    kind: QueueKind,
    text: string,
    images?: ImageContent[],
): Promise<SteerEnqueueResult> {
    // inspectExecution is the public AgentLane API for the live operation
    // (Lane.state is class-internal).
    const info = await lane.inspectExecution(harnessContext);
    if (info.current?.kind !== "run") return { mode: "idle" };
    const method = kind === "steer" ? "session.steer" : "session.followUp";
    const result =
        kind === "steer"
            ? await lane.steer(text, images, harnessContext)
            : await lane.followUp(text, images, harnessContext);
    if (!result.ok) throw toHarnessError(method, result.error);
    return { mode: "queued", entryId: result.value.entryId };
}

/** Remove one not-yet-consumed queue entry. "already_consumed" / "not_found" are normal outcomes. */
export async function cancelLaneQueued(
    lane: AgentLane,
    entryId: string,
): Promise<CancelQueuedKind> {
    const result = await lane.cancelQueued(entryId, harnessContext);
    if (!result.ok) throw toHarnessError("session.cancelQueued", result.error);
    return result.value.kind;
}
