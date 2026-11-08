/**
 * Undelivered background subagent results, persisted on the parent session.
 *
 * `deliverSubagentResult` is best-effort — it needs the parent's live
 * `AttachedSession` — and a lost notice leaves the parent believing the child
 * is still running. So the notice is recorded *before* delivery and cleared
 * only once it lands; leftovers are flushed on the next attach.
 *
 * One record per `parentToolCallId`, not a `list`: pi's list address only
 * supports append and whole-list delete. Only metadata lives here — the text
 * is already a file (see `subagentResultsDir.ts`).
 */

import type { SessionId } from "@taco-ai/protocol";
import { harnessContext } from "../../lib/harnessContext.ts";
import type { Context, Session } from "../pi/types.ts";
import { value } from "../pi/values.ts";

/** A background subagent result whose notice has not reached the parent yet. */
export interface PendingSubagentResult {
    /** Explicit provenance for newly tracked notices; older records derive it from the tool call. */
    readonly workId?: string;
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
