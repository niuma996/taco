import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    listDreamReportIds,
    readDreamReport,
    rollbackDreamLock,
    tryAcquireDreamLock,
    writeDreamReport,
} from "./dreamState.ts";

export type ArchiveRetentionDays = 7 | 30 | 90;

export interface ArchivePurgeCandidate {
    readonly key: string;
    readonly id: string;
    readonly entry: unknown;
    readonly archivedAt: string;
}

export interface ArchiveCleanupStore {
    readonly topicDir: string;
    purgeArchivedTopics?: (options: {
        retentionDays: ArchiveRetentionDays;
        now?: Date;
        protectedIds?: ReadonlySet<string>;
        beforeDelete?: (candidates: readonly ArchivePurgeCandidate[]) => void;
    }) => Promise<{ deleted: number; skipped: number }>;
}

export interface CleanupResult {
    readonly deleted: number;
    readonly skipped: number;
    readonly reportsScrubbed: number;
}

type CleanupReport = {
    readonly id: string;
    readonly appliedAt: string;
    readonly counts: unknown;
    readonly created?: readonly string[];
    readonly archived?: readonly string[];
    readonly rewritten?: readonly { readonly id: string }[];
    readonly skipped?: readonly string[];
    readonly undoneAt?: string;
    readonly undoExpiredAt?: string;
    readonly [key: string]: unknown;
};

function reportArchiveIds(report: CleanupReport): Set<string> {
    return new Set([
        ...(report.archived ?? []),
        ...(report.created ?? []),
        ...(report.rewritten ?? []).map((item) => item.id),
    ]);
}

/** Reports and previews are the only DREAM state that can name archive ids. */
export function protectedArchiveIds(topicDir: string): Set<string> {
    const protectedIds = new Set<string>();
    const pending = readJson<Record<string, unknown>>(topicDir, ".dream/pending.json");
    for (const action of Array.isArray(pending?.actions) ? pending.actions : []) {
        if (!action || typeof action !== "object") continue;
        const item = action as Record<string, unknown>;
        if (typeof item.id === "string") protectedIds.add(item.id);
        if (typeof item.supersededBy === "string") protectedIds.add(item.supersededBy);
        if (Array.isArray(item.sourceIds)) {
            for (const id of item.sourceIds) if (typeof id === "string") protectedIds.add(id);
        }
    }
    for (const id of listDreamReportIds(topicDir)) {
        const report = readDreamReport<CleanupReport>(topicDir, id);
        if (!report || report.undoExpiredAt || report.inProgress !== true) continue;
        for (const archiveId of reportArchiveIds(report)) protectedIds.add(archiveId);
    }
    return protectedIds;
}

function readJson<T>(topicDir: string, relative: string): T | undefined {
    try {
        return JSON.parse(readFileSync(join(topicDir, relative), "utf8")) as T;
    } catch {
        return undefined;
    }
}

function scrubReport(topicDir: string, id: string, now: Date): boolean {
    const report = readDreamReport<CleanupReport>(topicDir, id);
    if (!report || report.undoExpiredAt) return false;
    const scrubbed: CleanupReport = {
        id: report.id,
        appliedAt: report.appliedAt,
        counts: report.counts,
        ...(report.created ? { created: report.created } : {}),
        ...(report.archived ? { archived: report.archived } : {}),
        ...(report.rewritten
            ? { rewritten: report.rewritten.map(({ id: topicId }) => ({ id: topicId })) }
            : {}),
        ...(report.skipped ? { skipped: report.skipped } : {}),
        ...(report.undoneAt ? { undoneAt: report.undoneAt } : {}),
        undoExpiredAt: now.toISOString(),
    };
    writeDreamReport(topicDir, scrubbed);
    return true;
}

/**
 * Run archive deletion as a deterministic maintenance pass. The model is not
 * involved, and reports are scrubbed only after the storage worker selects
 * candidates and invokes the callback immediately before unlinking them.
 */
export async function cleanupArchivedTopics(
    store: ArchiveCleanupStore,
    retentionDays: ArchiveRetentionDays,
    now: Date = new Date(),
): Promise<CleanupResult> {
    if (!store.purgeArchivedTopics) return { deleted: 0, skipped: 0, reportsScrubbed: 0 };
    if (!tryAcquireDreamLock(store.topicDir)) return { deleted: 0, skipped: 0, reportsScrubbed: 0 };
    const protectedIds = protectedArchiveIds(store.topicDir);
    let reportsScrubbed = 0;
    try {
        const result = await store.purgeArchivedTopics({
            retentionDays,
            now,
            protectedIds,
            beforeDelete: (candidates) => {
                const ids = new Set(candidates.map((candidate) => candidate.id));
                for (const reportId of listDreamReportIds(store.topicDir)) {
                    const report = readDreamReport<CleanupReport>(store.topicDir, reportId);
                    if (!report || ![...reportArchiveIds(report)].some((id) => ids.has(id)))
                        continue;
                    if (scrubReport(store.topicDir, reportId, now)) reportsScrubbed++;
                }
            },
        });
        return { ...result, reportsScrubbed };
    } finally {
        rollbackDreamLock(store.topicDir);
    }
}
