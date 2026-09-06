/**
 * Branch-scoped session reads.
 *
 * pi 0.85 split entry queries into two shapes with different traversal:
 *
 *   - `Session.findEntries(EntryQuery, ctx)` scans the whole append log by
 *     sequence. It does NOT follow the parent chain, so a forked or
 *     navigated session returns entries that are not on the current branch.
 *   - `Branch.findEntries(BranchScan, ctx)` walks the parent chain from the
 *     branch tip. This is what pre-0.85 `session.getBranch()` did.
 *
 * Every sidecar caller wants the branch semantics: "the conversation as it
 * currently stands". Getting this wrong is silent — the wrong entries come
 * back rather than an error — so branch reads are funnelled through here
 * instead of being spelled out per call site.
 *
 * Lane names and branch names are the same namespace in pi 0.85: a lane
 * stores its tip under `branchTip(<lane name>)`, so the harness's default
 * "main" lane is branch "main".
 */

import {
    type AgentMessage,
    type Context,
    createBranchSummaryMessage,
    createCompactionSummaryMessage,
    type Entry,
    type Session,
} from "@earendil-works/pi-agent-core";
import { harnessContext } from "../lib/harnessContext.ts";

/** The harness's default lane, and therefore the default branch name. */
export const MAIN_BRANCH = "main";

/**
 * All entries on the session's main branch, oldest-first.
 *
 * `Branch.findEntries` defaults to `newestFirst`; pre-0.85 `getBranch()`
 * returned oldest-first and every caller (context assembly, compaction
 * cut-points, fork history) depends on that order, so ask for it explicitly
 * rather than reversing afterwards.
 *
 * Returns `[]` when the branch does not exist yet — a session that has been
 * created but never written to has no tip.
 */
export async function findBranchEntries(
    session: Session,
    context: Context = harnessContext,
): Promise<Entry[]> {
    const branch = await session.branch(MAIN_BRANCH, context);
    if (branch === undefined) return [];
    return branch.findEntries({ order: "oldestFirst" }, context);
}

/**
 * The main branch's tip entry id, or `null` when the branch has no entries.
 *
 * Replaces pre-0.85 `session.getLeafId()`.
 */
export async function findBranchTipId(
    session: Session,
    context: Context = harnessContext,
): Promise<string | null> {
    const branch = await session.branch(MAIN_BRANCH, context);
    if (branch === undefined) return null;
    return branch.getTipId(context);
}

/**
 * Whether a message belongs in model context.
 *
 * Failed, aborted and deferred assistant turns are persisted for the
 * transcript but withheld from the model. Mirrors pi's `isContextMessage`.
 */
function isContextMessage(message: AgentMessage): boolean {
    return (
        message.role !== "assistant" ||
        (message.stopReason !== "error" &&
            message.stopReason !== "aborted" &&
            message.stopReason !== "deferred")
    );
}

/**
 * Project one entry to the messages it contributes to model context.
 *
 * Mirrors pi's internal `sessionEntryToContextMessages`. pi does not export
 * that function (it is absent from the barrel in both 0.85.0 and 0.85.1), so
 * the projection is reproduced here from the public message builders. Custom
 * entries contribute nothing — sidecar tags inject their own text via context
 * hooks rather than through entry projection.
 */
function entryToContextMessages(entry: Entry): AgentMessage[] {
    switch (entry.type) {
        case "message":
            return isContextMessage(entry.message) ? [entry.message] : [];
        case "compaction":
            return [
                createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
                ...entry.retainedTail.filter(isContextMessage),
            ];
        case "branch_summary":
            return entry.summary
                ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)]
                : [];
        case "custom":
            return [];
    }
}

/**
 * The message list the model would see for the current branch.
 *
 * Replaces pre-0.85 `session.buildContext().messages`. Entries before the most
 * recent compaction are dropped in favour of that compaction's summary, which
 * is what makes this a context view rather than a full transcript.
 */
export async function buildBranchContext(
    session: Session,
    context: Context = harnessContext,
): Promise<AgentMessage[]> {
    const entries = await findBranchEntries(session, context);

    // Everything at or after the newest compaction; the compaction entry
    // itself projects to a summary message standing in for the prefix.
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === "compaction") {
            start = i;
            break;
        }
    }

    const messages: AgentMessage[] = [];
    for (let i = start; i < entries.length; i++) {
        const entry = entries[i];
        if (entry !== undefined) messages.push(...entryToContextMessages(entry));
    }
    return messages;
}
