import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { WorkQueueStore } from "../../src/work/workQueueStore.ts";

async function rig(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "work-queue-index-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { store: new WorkQueueStore(root), root };
}

const intent = (sourceEventId: string) => ({
    sourceEventId,
    kind: "scheduled" as const,
    title: "task",
    jobId: "job",
    workspace: "/a",
    sessionId: "s",
    lane: "main" as const,
    payload: { text: sourceEventId },
});

const isSafeQueueId = (id: string) => /^q-[a-f0-9]{32}$/.test(id);

describe("WorkQueueStore derived index", () => {
    it("is a cache: deleting it leaves records readable and re-creates it", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        const b = (await store.enqueue(intent("b"))).entry;
        const indexPath = join(root, "_index.json");
        await rm(indexPath);
        // Records are authoritative; a deleted index must not lose them.
        assert.deepEqual(
            (await store.list()).map((e) => e.queueId),
            [a.queueId, b.queueId],
        );
        // Next enqueue rebuilds the cache rather than failing.
        const c = (await store.enqueue(intent("c"))).entry;
        assert.equal(c.sequence, 3);
        assert.ok(isSafeQueueId(c.queueId));
        assert.ok(JSON.parse(await readFile(indexPath, "utf8")).entries[a.queueId]);
    });

    it("ignores a corrupt index and rebuilds from the records", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        await writeFile(join(root, "_index.json"), "{not-json", "utf8");
        const b = (await store.enqueue(intent("b"))).entry;
        assert.equal(b.sequence, a.sequence + 1);
        assert.deepEqual(
            (await store.list()).map((e) => e.queueId),
            [a.queueId, b.queueId],
        );
    });

    it("re-reads records when a cached sequence is invalid", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        await store.enqueue(intent("b"));
        const indexPath = join(root, "_index.json");
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.entries[a.queueId].summary.sequence = "bad";
        await writeFile(indexPath, JSON.stringify(index), "utf8");

        const c = (await store.enqueue(intent("c"))).entry;
        assert.equal(c.sequence, 3);
        assert.deepEqual(
            (await store.list()).map((e) => e.sequence),
            [1, 2, 3],
        );
    });

    it("re-reads records when a cached status is invalid", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        const path = join(root, `${a.queueId}.json`);
        const edited = JSON.parse(await readFile(path, "utf8"));
        edited.status = "failed";
        await writeFile(path, JSON.stringify(edited), "utf8");
        const b = (await store.enqueue(intent("b"))).entry;
        await rm(join(root, `${b.queueId}.json`));
        const indexPath = join(root, "_index.json");
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.entries[a.queueId].summary.status = "bogus";
        await writeFile(indexPath, JSON.stringify(index), "utf8");

        const c = await new WorkQueueStore(root, 1).enqueue(intent("c"));
        assert.equal(c.created, true);
    });

    it("re-reads a record a hand edit changed, instead of trusting its stamp", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        // The index now records "a" as queued. Cancel it on disk only, as an
        // operator edit would, leaving the index stale.
        const path = join(root, `${a.queueId}.json`);
        const edited = JSON.parse(await readFile(path, "utf8"));
        edited.status = "cancelled";
        await writeFile(path, JSON.stringify(edited), "utf8");
        // Force an mtime change even on coarse filesystems.
        await utimes(path, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
        // With pendingLimit 1, a stale index still counting "a" as queued would
        // fill the queue; the cancelled edit must free the slot.
        const limited = new WorkQueueStore(root, 1);
        const c = await limited.enqueue(intent("c"));
        assert.equal(c.created, true);
    });

    it("detects a same-size hand edit that restores the record mtime", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        const path = join(root, `${a.queueId}.json`);
        const fixed = new Date(Date.now() + 2000);
        await utimes(path, fixed, fixed);
        const b = (await store.enqueue(intent("b"))).entry;
        await rm(join(root, `${b.queueId}.json`));
        const edited = JSON.parse(await readFile(path, "utf8"));
        edited.status = "failed";
        await writeFile(path, JSON.stringify(edited), "utf8");
        await utimes(path, fixed, fixed);

        const c = await new WorkQueueStore(root, 1).enqueue(intent("c"));
        assert.equal(c.created, true);
    });

    it("does not treat the index file itself as a record", async (t) => {
        const { store } = await rig(t);
        await store.enqueue(intent("a"));
        await store.enqueue(intent("b"));
        const listed = await store.list();
        assert.equal(listed.length, 2);
        assert.ok(listed.every((e) => isSafeQueueId(e.queueId)));
    });

    it("indexes the record it just wrote", async (t) => {
        const { store, root } = await rig(t);
        const a = (await store.enqueue(intent("a"))).entry;
        const index = JSON.parse(await readFile(join(root, "_index.json"), "utf8"));
        assert.equal(index.entries[a.queueId].summary.sequence, a.sequence);
        assert.equal(index.entries[a.queueId].summary.status, "queued");
    });

    it("keeps sequence monotonic across many enqueues", async (t) => {
        const { store } = await rig(t);
        const sequences: number[] = [];
        for (let i = 0; i < 30; i++)
            sequences.push((await store.enqueue(intent(`e${i}`))).entry.sequence);
        assert.deepEqual(
            sequences,
            Array.from({ length: 30 }, (_, i) => i + 1),
        );
    });
});
