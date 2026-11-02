/**
 * Read-side projection of Work records for the `work.*` RPCs.
 *
 * Pure functions over `WorkRecord`: no store, no clock, no I/O, so the grouping
 * and paging rules can be tested without a daemon. The wire shape comes from
 * `@taco-ai/protocol`; this module only decides what goes into it.
 */

import {
    WORK_LIST_DEFAULT_LIMIT,
    WORK_RETRYABLE_DELIVERY_STATUSES,
    type WorkDeliverySummary,
    type WorkListResult,
    type WorkSummary,
} from "@taco-ai/protocol";
import type { WorkRecord } from "./workTypes.ts";
import { isTerminal } from "./workTypes.ts";

/** Delivery states that are worth a person's attention. */
const ATTENTION_DELIVERY: ReadonlySet<string> = new Set(WORK_RETRYABLE_DELIVERY_STATUSES);

/**
 * A Work needs attention when the user was not told and nothing will fix that
 * on its own, or when the run was cut short by a crash. A run that simply
 * failed is a finished result, not a to-do: the notice already said so.
 */
export function needsAttention(work: WorkRecord): boolean {
    if (work.status === "interrupted") return true;
    const status = work.delivery?.status;
    return status !== undefined && ATTENTION_DELIVERY.has(status);
}

function summarizeDelivery(work: WorkRecord): WorkDeliverySummary | undefined {
    const d = work.delivery;
    if (!d) return undefined;
    return {
        status: d.status,
        channelId: d.target.channelId,
        attempts: d.attempts,
        ...(d.lastError !== undefined ? { lastError: d.lastError } : {}),
        ...(d.source !== undefined ? { source: d.source } : {}),
        ...(d.nextAttemptAt !== undefined ? { nextAttemptAt: d.nextAttemptAt } : {}),
    };
}

export function toSummary(work: WorkRecord): WorkSummary {
    return {
        workId: work.workId,
        revision: work.revision,
        kind: work.kind,
        title: work.title,
        agentType: work.agentType,
        status: work.status,
        ...(work.reason !== undefined ? { reason: work.reason } : {}),
        createdAt: work.createdAt,
        updatedAt: work.updatedAt,
        ...(work.endedAt !== undefined ? { endedAt: work.endedAt } : {}),
        ...(work.workspace !== undefined ? { workspace: work.workspace } : {}),
        parentSessionId: work.parentSessionId,
        childSessionId: work.childSessionId,
        ...(work.result ? { completeness: work.result.completeness } : {}),
        ...(work.result?.summary !== undefined ? { summary: work.result.summary } : {}),
        ...(work.delivery ? { delivery: summarizeDelivery(work) } : {}),
        needsAttention: needsAttention(work),
    };
}

/**
 * Where a page of finished Works starts. Sorted newest first by `(endedAt ??
 * updatedAt, workId)`; the cursor names the last row of the previous page, so a
 * Work that finishes between two requests cannot shift the rows already seen.
 */
function sortKey(work: WorkRecord): number {
    return work.endedAt ?? work.updatedAt;
}

function compareNewestFirst(a: WorkRecord, b: WorkRecord): number {
    return sortKey(b) - sortKey(a) || (a.workId < b.workId ? 1 : a.workId > b.workId ? -1 : 0);
}

export function encodeCursor(work: WorkRecord): string {
    return `${sortKey(work)}:${work.workId}`;
}

function parseCursor(raw: string): { at: number; workId: string } | undefined {
    const split = raw.indexOf(":");
    if (split < 1) return undefined;
    const at = Number(raw.slice(0, split));
    const workId = raw.slice(split + 1);
    if (!Number.isFinite(at) || workId === "") return undefined;
    return { at, workId };
}

export interface WorkListArgs {
    readonly limit?: number;
    readonly before?: string;
}

/**
 * Split the records into the two groups the overview shows.
 *
 * `active` is everything still running plus every finished Work that needs
 * attention, and is always returned whole: those are the rows a person must be
 * able to see without paging. `terminal` is the rest, one page at a time.
 */
export function buildList(
    records: readonly WorkRecord[],
    args: WorkListArgs,
    instanceId: string,
): WorkListResult {
    const limit = args.limit ?? WORK_LIST_DEFAULT_LIMIT;
    const active: WorkRecord[] = [];
    const finished: WorkRecord[] = [];
    for (const record of records) {
        if (!isTerminal(record.status) || needsAttention(record)) active.push(record);
        else finished.push(record);
    }
    active.sort((a, b) => b.createdAt - a.createdAt || (a.workId < b.workId ? 1 : -1));
    finished.sort(compareNewestFirst);

    const cursor = args.before !== undefined ? parseCursor(args.before) : undefined;
    const rest =
        cursor === undefined
            ? finished
            : finished.filter(
                  (w) =>
                      sortKey(w) < cursor.at ||
                      (sortKey(w) === cursor.at && w.workId < cursor.workId),
              );
    const page = rest.slice(0, limit);
    const last = page.at(-1);
    return {
        instanceId,
        active: active.map(toSummary),
        terminal: page.map(toSummary),
        ...(rest.length > page.length && last ? { nextCursor: encodeCursor(last) } : {}),
    };
}
