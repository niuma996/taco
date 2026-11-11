/**
 * The work summary index is a cache for identity and cancellation scans.
 * Record files stay authoritative; `list()` does not read the index.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { QUEUE_INDEX_FILE, WorkQueueStore } from "../../src/work/workQueueStore.ts";
import {
    isSafeWorkId,
    legacyWorkIdForSource,
    WORK_INDEX_FILE,
    WorkStore,
    workIdForSource,
} from "../../src/work/workStore.ts";
import { WORK_SCHEMA_VERSION, type WorkRecord } from "../../src/work/workTypes.ts";

async function rig(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "work-index-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { store: new WorkStore(root), root };
}

function record(sourceEventId: string, overrides: Partial<WorkRecord> = {}): WorkRecord {
    const workspace = "/proj";
    return {
        schemaVersion: WORK_SCHEMA_VERSION,
        workId: legacyWorkIdForSource(sourceEventId),
        revision: 0,
        kind: "subagent",
        title: "t",
        sourceEventId,
        parentSessionId: "p",
        childSessionId: "c",
        agentType: "explorer",
        status: "running",
        ownerInstanceId: "inst-1",
        createdAt: 1,
        updatedAt: 1,
        workspace,
        attempt: {
            attemptId: "a-1",
            startedAt: 1,
            operation: {
                workspace,
                sessionId: "child",
                lane: "main",
                operationId: "op-1",
            },
        },
        ...overrides,
    };
}

const alias = (sourceEventId: string, workspace = "/proj") =>
    workIdForSource(sourceEventId, workspace);

describe("WorkStore derived index", () => {
    it("is a cache: deleting it still resolves an alias and re-creates it", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        assert.equal(await store.resolveId(alias("src")), rec.workId);
        const indexPath = join(root, WORK_INDEX_FILE);
        await rm(indexPath);
        assert.equal(await store.resolveId(alias("src")), rec.workId);
        assert.ok(JSON.parse(await readFile(indexPath, "utf8")).entries[rec.workId]);
    });

    it("ignores a corrupt index and rebuilds from the records", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        await store.resolveId(alias("src"));
        const indexPath = join(root, WORK_INDEX_FILE);
        await writeFile(indexPath, "{not-json", "utf8");
        assert.equal(await store.resolveId(alias("src")), rec.workId);
        const rebuilt = JSON.parse(await readFile(indexPath, "utf8"));
        assert.equal(rebuilt.version, 1);
        assert.equal(Array.isArray(rebuilt.entries), false);
    });

    it("re-reads records when a cached summary is invalid", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src", {
            attempt: {
                attemptId: "a-1",
                startedAt: 1,
                cancelRequestedAt: 5,
                operation: {
                    workspace: "/proj",
                    sessionId: "child",
                    lane: "main",
                    operationId: "op-1",
                },
            },
        });
        await store.createIfAbsent(rec);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
        const indexPath = join(root, WORK_INDEX_FILE);
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.entries[rec.workId].summary.status = "bogus";
        await writeFile(indexPath, JSON.stringify(index), "utf8");
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
    });

    it("sees a cancel flag a hand edit added", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
        const path = join(root, rec.workId, "work.json");
        const edited = JSON.parse(await readFile(path, "utf8"));
        edited.attempt.cancelRequestedAt = 9;
        await writeFile(path, JSON.stringify(edited, null, 2), "utf8");
        await utimes(path, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
    });

    it("sees a same-size hand edit that restores the record mtime", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src", {
            attempt: {
                attemptId: "a-1",
                startedAt: 1,
                cancelRequestedAt: 5,
                operation: {
                    workspace: "/proj",
                    sessionId: "child",
                    lane: "main",
                    operationId: "op-1",
                },
            },
        });
        await store.createIfAbsent(rec);
        const path = join(root, rec.workId, "work.json");
        const fixed = new Date(Date.now() + 2000);
        await utimes(path, fixed, fixed);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
        const raw = await readFile(path, "utf8");
        const edited = JSON.parse(raw);
        edited.status = "waiting";
        const next = JSON.stringify(edited, null, 2);
        assert.equal(Buffer.byteLength(next), Buffer.byteLength(raw));
        await writeFile(path, next, "utf8");
        await utimes(path, fixed, fixed);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
    });

    it("resolves an alias from the edited workspace, not the cached one", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        const path = join(root, rec.workId, "work.json");
        const fixed = new Date(Date.now() + 2000);
        await utimes(path, fixed, fixed);
        assert.equal(await store.resolveId(alias("src", "/proj")), rec.workId);
        const raw = await readFile(path, "utf8");
        const edited = JSON.parse(raw);
        edited.workspace = "/pr0j";
        const next = JSON.stringify(edited, null, 2);
        assert.equal(Buffer.byteLength(next), Buffer.byteLength(raw));
        await writeFile(path, next, "utf8");
        await utimes(path, fixed, fixed);
        assert.equal(await store.resolveId(alias("src", "/proj")), undefined);
        assert.equal(await store.resolveId(alias("src", "/pr0j")), rec.workId);
    });

    it("does not treat the index file, or an extra index id, as a record", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src", {
            attempt: {
                attemptId: "a-1",
                startedAt: 1,
                cancelRequestedAt: 5,
                operation: {
                    workspace: "/proj",
                    sessionId: "child",
                    lane: "main",
                    operationId: "op-1",
                },
            },
        });
        await store.createIfAbsent(rec);
        await store.cancellationRequested("/proj", "child", "op-1");
        const indexPath = join(root, WORK_INDEX_FILE);
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.entries.ghost = {
            stamp: { mtimeMs: 1, ctimeMs: 1, size: 1 },
            summary: {
                sourceEventId: "nope",
                status: "running",
                cancelRequestedAt: 1,
                operation: { workspace: "/proj", sessionId: "child", operationId: "ghost-op" },
            },
        };
        await writeFile(indexPath, JSON.stringify(index), "utf8");
        assert.equal(await store.cancellationRequested("/proj", "child", "ghost-op"), false);
        assert.equal(await store.resolveId(alias("nope")), undefined);
        const listed = await store.list();
        assert.equal(listed.length, 1);
        assert.ok(listed.every((item) => isSafeWorkId(item.workId)));
        assert.equal(listed[0]?.title, "t");
    });

    it("discards an array index instead of trusting index 0 as a work id", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src", {
            workId: "0",
            attempt: {
                attemptId: "a-1",
                startedAt: 1,
                cancelRequestedAt: 5,
                operation: {
                    workspace: "/proj",
                    sessionId: "child",
                    lane: "main",
                    operationId: "op-1",
                },
            },
        });
        await store.createIfAbsent(rec);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
        const indexPath = join(root, WORK_INDEX_FILE);
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        const stamped = index.entries["0"];
        stamped.summary.status = "waiting";
        await writeFile(indexPath, JSON.stringify({ version: 1, entries: [stamped] }), "utf8");
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
        assert.equal(Array.isArray(JSON.parse(await readFile(indexPath, "utf8")).entries), false);
    });

    it("sees a cancel written through mutate after the index exists", async (t) => {
        const { store } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
        await store.mutate(rec.workId, (current) => ({
            ...current,
            attempt: { ...current.attempt, cancelRequestedAt: 9 },
        }));
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), true);
    });

    it("still resolves a deleted owner from its marker", async (t) => {
        const { store } = await rig(t);
        const rec = record("gone", { status: "completed" });
        await store.createIfAbsent(rec);
        assert.equal(await store.resolveId(alias("gone")), rec.workId);
        await store.markDeleted(rec.workId);
        assert.equal(await store.resolveId(alias("gone")), rec.workId);
        assert.deepEqual(await store.list(), []);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
    });

    it("does not create the store directory when nothing is there", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "work-index-missing-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const missing = join(root, "absent");
        const store = new WorkStore(missing);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
        await assert.rejects(stat(missing));
    });

    it("does not rewrite the index when the scan is unchanged", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        await store.cancellationRequested("/proj", "child", "op-1");
        const indexPath = join(root, WORK_INDEX_FILE);
        const before = await stat(indexPath);
        await store.cancellationRequested("/proj", "child", "op-1");
        await store.resolveId(alias("src"));
        const after = await stat(indexPath);
        assert.equal(after.ino, before.ino);
        assert.equal(after.ctimeMs, before.ctimeMs);
    });

    it("list still reads the record when the index summary is wrong", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        await store.resolveId(alias("src"));
        const indexPath = join(root, WORK_INDEX_FILE);
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.entries[rec.workId].summary.status = "completed";
        await writeFile(indexPath, JSON.stringify(index), "utf8");
        const listed = await store.list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.status, "running");
        assert.equal(listed[0]?.title, "t");
    });

    it("does not scan tombstone or interaction directories as work ids", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        const planted = record("other", {
            attempt: {
                attemptId: "a-1",
                startedAt: 1,
                cancelRequestedAt: 5,
                operation: {
                    workspace: "/proj",
                    sessionId: "child",
                    lane: "main",
                    operationId: "op-1",
                },
            },
        });
        for (const name of ["deleted", "interactions"]) {
            await mkdir(join(root, name), { recursive: true });
            await writeFile(
                join(root, name, "work.json"),
                JSON.stringify({ ...planted, workId: name, title: "not-a-record" }, null, 2),
            );
        }
        const listed = await store.list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.workId, rec.workId);
        assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
    });

    it("keeps its index when a queue store uses the same directory", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        await store.cancellationRequested("/proj", "child", "op-1");
        const before = await readFile(join(root, WORK_INDEX_FILE), "utf8");
        assert.notEqual(WORK_INDEX_FILE, QUEUE_INDEX_FILE);
        assert.equal(QUEUE_INDEX_FILE, "_index.json");
        const queue = new WorkQueueStore(root);
        const queued = (
            await queue.enqueue({
                sourceEventId: "q",
                kind: "scheduled",
                title: "task",
                jobId: "job",
                workspace: "/a",
                sessionId: "s",
                lane: "main",
                payload: { text: "q" },
            })
        ).entry;
        assert.equal(await readFile(join(root, WORK_INDEX_FILE), "utf8"), before);
        const queueIndex = JSON.parse(await readFile(join(root, QUEUE_INDEX_FILE), "utf8"));
        assert.equal(queueIndex.entries[queued.queueId].summary.status, "queued");
    });

    it("still answers when the index cannot be written", async (t) => {
        const { store, root } = await rig(t);
        const rec = record("src");
        await store.createIfAbsent(rec);
        await chmod(root, 0o500);
        try {
            assert.equal(await store.cancellationRequested("/proj", "child", "op-1"), false);
        } finally {
            await chmod(root, 0o700);
        }
    });
});
