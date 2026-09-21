/**
 * Undelivered background subagent results, persisted on the parent session.
 *
 * `deliverSubagentResult` is best-effort by construction: it needs the parent's
 * live `AttachedSession`, and there are normal states where that route is
 * closed — the parent is mid-compaction (compaction occupies the lane without
 * consuming either queue, so `followUp` reports idle and the retry `prompt()`
 * hits busy again), the workspace was disposed, or the process restarted
 * between the child settling and the notice landing.
 *
 * In all of those the result itself is safe on disk; only the *notice* was
 * lost, which is worse than it sounds — the parent goes on believing the child
 * is still running. So the notice is recorded here before delivery is attempted
 * and cleared once it lands, and whatever is left over is flushed the next time
 * the parent attaches.
 *
 * Stored as one record keyed by `parentToolCallId` rather than a `list`:
 * clearing a single delivered entry has to be possible, and pi's list address
 * only supports append and whole-list delete.
 *
 * Only metadata lives here. The result text is already a file (see
 * `subagentResultsDir.ts`) and re-persisting it would double the cost of a
 * large answer while adding a second thing to keep consistent.
 */

import type { SessionId } from "@taco-ai/protocol";
import { harnessContext } from "../../lib/harnessContext.ts";
import type { Context, Session } from "../pi/types.ts";
import { value } from "../pi/values.ts";

/** A background subagent result whose notice has not reached the parent yet. */
export interface PendingSubagentResult {
    readonly subSessionId: SessionId;
    readonly parentToolCallId: string;
    readonly agentType: string;
    readonly outcome: "completed" | "error" | "aborted";
    /** Epoch millis the child settled — lets a flush report how stale the notice is. */
    readonly settledAt: number;
    /** Where the result text was written, absent if that write failed. */
    readonly resultPath?: string;
    /**
     * Task label from the original `agent` call, carried so a late notice can
     * still say what the subagent was for. By flush time the conversation has
     * moved on by definition, and a compaction may have collapsed the tool call
     * that would otherwise identify it.
     */
    readonly description?: string;
}

/** `parentToolCallId` → pending record. */
type PendingMap = Record<string, PendingSubagentResult>;

/** Address of the pending-results record. One per parent session. */
export const SUBAGENT_PENDING = value<PendingMap>("taco.subagent.pending");

/** Read the parent's undelivered notices. `{}` when there are none. */
export async function readPendingSubagentResults(
    session: Session,
    context: Context = harnessContext,
): Promise<PendingMap> {
    const stored = await session.getValue(SUBAGENT_PENDING, context);
    return stored?.value ?? {};
}

/**
 * Record a notice as undelivered.
 *
 * Called before the delivery attempt, not after a failure: a crash between the
 * child settling and the delivery returning must still leave a trace, and an
 * entry that turns out to be deliverable is cheap to remove.
 */
export async function addPendingSubagentResult(
    session: Session,
    entry: PendingSubagentResult,
    context: Context = harnessContext,
): Promise<void> {
    const existing = await readPendingSubagentResults(session, context);
    await session.setValue(
        SUBAGENT_PENDING,
        { ...existing, [entry.parentToolCallId]: entry },
        context,
    );
}

/**
 * Drop one notice after it was delivered.
 *
 * A no-op when the entry is already gone, which is the normal outcome of a
 * flush racing a live delivery for the same child.
 */
export async function clearPendingSubagentResult(
    session: Session,
    parentToolCallId: string,
    context: Context = harnessContext,
): Promise<void> {
    const existing = await readPendingSubagentResults(session, context);
    if (!(parentToolCallId in existing)) return;
    const next: PendingMap = { ...existing };
    delete next[parentToolCallId];
    await session.setValue(SUBAGENT_PENDING, next, context);
}
