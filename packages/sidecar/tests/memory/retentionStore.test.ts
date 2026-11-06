import { strict as assert } from "node:assert";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { LocalMemoryStore } from "../../src/memory/local/store.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";

const workspace = asWorkspaceId("/tmp/memory-retention");

function entry(id: string): MemoryEntry {
    return {
        id,
        name: id,
        description: "retention test",
        type: "reference",
        content: `body for ${id}`,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-02-01T00:00:00.000Z",
    };
}

function setArchivedAt(path: string, archivedAt: string): void {
    const raw = readFileSync(path, "utf8");
    writeFileSync(
        path,
        raw.includes("archivedAt:")
            ? raw.replace(/^archivedAt: .*$/m, `archivedAt: ${archivedAt}`)
            : raw.replace(/^createdAt: .*$/m, (line) => `${line}\narchivedAt: ${archivedAt}`),
    );
}

describe("memory archive retention", () => {
    let root: string;
    let previousHome: string | undefined;
    let store: LocalMemoryStore;

    beforeEach(() => {
        previousHome = process.env.TACO_HOME;
        root = mkdtempSync(join(tmpdir(), "taco-memory-retention-"));
        process.env.TACO_HOME = root;
        store = new LocalMemoryStore();
        store.initialize(workspace);
    });

    afterEach(() => {
        if (previousHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
        else process.env.TACO_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    });

    it("persists an archive age, returns it, and clears it on restore", async () => {
        await store.appendEntry(entry("topic"));
        const archived = await store.archiveTopic("topic");

        assert.match(archived.archivedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(archived.createdAt, "2025-01-01T00:00:00.000Z");
        assert.equal(archived.updatedAt, "2025-02-01T00:00:00.000Z");
        assert.equal(store.listTopics().length, 0);
        assert.equal(store.listArchivedTopics()[0]?.archivedAt, archived.archivedAt);

        await store.restoreTopic("topic", { expectedEntry: archived });
        assert.equal(store.getTopic("topic")?.archivedAt, undefined);
        assert.equal(store.listArchivedTopics().length, 0);
    });

    it("purges expired current and history archives while protecting ids", async () => {
        await store.appendEntry(entry("retired"));
        await store.archiveTopic("retired");
        await store.restoreTopic("retired");
        await store.updateTopic("retired", "new body");
        await store.archiveTopic("retired");
        await store.appendEntry(entry("protected"));
        await store.archiveTopic("protected");

        const archiveDir = join(store.topicDir, "archive");
        mkdirSync(join(archiveDir, "history"), { recursive: true });
        copyFileSync(
            join(archiveDir, "retired.md"),
            join(archiveDir, "history", "retired.2020-01-01T00-00-00-000Z.md"),
        );
        const old = "2020-01-01T00:00:00.000Z";
        for (const file of readdirSync(archiveDir, { recursive: true })) {
            if (typeof file === "string" && file.endsWith(".md")) {
                setArchivedAt(join(archiveDir, file), old);
            }
        }

        const seen: string[] = [];
        const result = await store.purgeArchivedTopics({
            retentionDays: 7,
            now: new Date("2020-02-01T00:00:00.000Z"),
            protectedIds: new Set(["protected"]),
            beforeDelete: (candidates) => seen.push(...candidates.map((candidate) => candidate.id)),
        });

        assert.equal(result.deleted, 2);
        assert.equal(result.skipped, 1);
        assert.deepEqual(seen.sort(), ["retired", "retired"]);
        assert.equal(existsSync(join(archiveDir, "retired.md")), false);
        assert.equal(existsSync(join(archiveDir, "protected.md")), true);
        assert.equal(readdirSync(join(archiveDir, "history")).length, 0);
    });

    it("uses createdAt as the age anchor for legacy archives without archivedAt", async () => {
        await store.appendEntry(entry("legacy"));
        await store.archiveTopic("legacy");
        const archivePath = join(store.topicDir, "archive", "legacy.md");
        writeFileSync(
            archivePath,
            readFileSync(archivePath, "utf8").replace(/^archivedAt: .*\n/m, ""),
        );

        const result = await store.purgeArchivedTopics({
            retentionDays: 7,
            now: new Date("2030-01-01T00:00:00.000Z"),
        });
        assert.deepEqual(result, { deleted: 1, skipped: 0 });
        assert.equal(existsSync(archivePath), false);
    });

    it("promotes explicit requests and never downgrades them", async () => {
        await store.appendEntry({ ...entry("sticky"), explicitlyRequested: false });
        await store.updateTopic("sticky", "changed", { explicitlyRequested: true });
        await store.updateTopic("sticky", "changed again", { explicitlyRequested: false });
        assert.equal(store.getTopic("sticky")?.explicitlyRequested, true);
    });
});
