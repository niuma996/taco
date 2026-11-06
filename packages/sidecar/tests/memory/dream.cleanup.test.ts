import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type ArchiveCleanupStore, cleanupArchivedTopics } from "../../src/memory/dream/cleanup.ts";
import {
    readDreamReport,
    writeDreamReport,
    writePendingPlan,
} from "../../src/memory/dream/dreamState.ts";

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "taco-dream-cleanup-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("dream archive cleanup", () => {
    it("protects pending and in-progress archive ids", async () => {
        writePendingPlan(root, {
            actions: [{ action: "archive", id: "pending-id" }],
        });
        writeDreamReport(root, {
            id: "in-progress",
            appliedAt: "2026-01-01T00:00:00.000Z",
            counts: {},
            created: ["created-id"],
            archived: ["archived-id"],
            rewritten: [],
            skipped: [],
            inProgress: true,
        });

        let protectedIds: ReadonlySet<string> | undefined;
        const store: ArchiveCleanupStore = {
            topicDir: root,
            purgeArchivedTopics: async (options) => {
                protectedIds = options.protectedIds;
                return { deleted: 0, skipped: 0 };
            },
        };

        await cleanupArchivedTopics(store, 7, new Date("2026-01-08T00:00:00.000Z"));
        assert.deepEqual([...(protectedIds ?? new Set())].sort(), [
            "archived-id",
            "created-id",
            "pending-id",
        ]);
    });

    it("scrubs affected reports before deletion and expires undo", async () => {
        writeDreamReport(root, {
            id: "report",
            appliedAt: "2026-01-01T00:00:00.000Z",
            counts: { merged: 1, mergedInto: 1, rewritten: 1, archived: 2 },
            created: ["merged"],
            archived: ["old"],
            rewritten: [{ id: "rewritten", before: "private body" }],
            written: { merged: "private merged body", rewritten: "private rewrite" },
            beforeEntries: { old: { content: "private old" } },
            writtenEntries: { merged: { content: "private merged" } },
            skipped: [],
        });

        const store: ArchiveCleanupStore = {
            topicDir: root,
            purgeArchivedTopics: async (options) => {
                options.beforeDelete?.([
                    {
                        key: "old.md",
                        id: "old",
                        entry: {},
                        archivedAt: "2026-01-01T00:00:00.000Z",
                    },
                ]);
                return { deleted: 1, skipped: 0 };
            },
        };

        const result = await cleanupArchivedTopics(store, 7, new Date("2026-01-08T00:00:00.000Z"));
        assert.equal(result.deleted, 1);
        assert.equal(result.reportsScrubbed, 1);
        const report = readDreamReport<Record<string, unknown>>(root, "report");
        assert.equal(report?.undoExpiredAt, "2026-01-08T00:00:00.000Z");
        assert.equal(report?.written, undefined);
        assert.equal(report?.beforeEntries, undefined);
        assert.deepEqual(report?.rewritten, [{ id: "rewritten" }]);
    });
});
