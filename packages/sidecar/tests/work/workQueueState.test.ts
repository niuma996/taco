import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
    QUEUE_RETENTION_COUNT,
    QUEUE_RETENTION_MS,
    WorkQueueStore,
} from "../../src/work/workQueueStore.ts";
import type { WorkQueueEntry, WorkQueueStatus } from "../../src/work/workQueueTypes.ts";

const DAY = 24 * 60 * 60_000;
const MAX_WAIT_MS = DAY;

async function rig(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "work-queue-state-"));
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

const queueIdFor = (index: number) => `q-${String(index).padStart(32, "0")}`;

async function writeEntry(
    root: string,
    index: number,
    status: WorkQueueStatus,
    updatedAt: number,
    sequence = index + 1,
): Promise<WorkQueueEntry> {
    const entry: WorkQueueEntry = {
        ...intent(`event-${index}`),
        schemaVersion: 1,
        queueId: queueIdFor(index),
        sequence,
        revision: 0,
        status,
        enqueuedAt: updatedAt,
        updatedAt,
        deadlineAt: updatedAt + MAX_WAIT_MS,
    };
    await writeFile(join(root, `${entry.queueId}.json`), JSON.stringify(entry), "utf8");
    return entry;
}

it("listOpen reads only live entries and keeps FIFO order", async (t) => {
    const { store, root } = await rig(t);
    const open = await store.enqueue(intent("a"), 10);
    await writeEntry(root, 7, "completed", 20);

    assert.deepEqual(
        (await store.listOpen()).map((entry) => entry.queueId),
        [open.entry.queueId],
    );
    assert.equal((await store.list()).length, 2);
});

it("rebuilds the live view from disk when a new instance starts", async (t) => {
    const { store, root } = await rig(t);
    const first = await store.enqueue(intent("a"), 10);

    const restarted = new WorkQueueStore(root);
    const second = await restarted.enqueue(intent("b"), 20);
    assert.ok(second.entry.sequence > first.entry.sequence);
    assert.deepEqual(
        (await restarted.listOpen()).map((entry) => entry.sequence),
        [first.entry.sequence, second.entry.sequence],
    );
});

it("prunes finished entries by age but never a live one", async (t) => {
    const { store, root } = await rig(t);
    const now = Date.now();
    const stale = await writeEntry(root, 1, "completed", now - QUEUE_RETENTION_MS - 1);
    const recent = await writeEntry(root, 2, "failed", now - DAY);
    const live = await writeEntry(root, 3, "queued", now - QUEUE_RETENTION_MS - DAY);

    assert.equal(await store.prune(now), 1);
    assert.deepEqual(
        (await store.list()).map((entry) => entry.queueId).sort(),
        [recent.queueId, live.queueId].sort(),
    );
    assert.equal(await store.get(stale.queueId), undefined);
});

it("keeps only the newest finished entries beyond the retention count", async (t) => {
    const { store, root } = await rig(t);
    const now = Date.now();
    const total = QUEUE_RETENTION_COUNT + 5;
    for (let index = 0; index < total; index++)
        await writeEntry(root, index, "completed", now - (total - index) * 1000, index + 1);
    const live = await store.enqueue(intent("live"), now);

    assert.equal(await store.prune(now), 5);
    assert.equal((await store.list()).length, QUEUE_RETENTION_COUNT + 1);
    assert.deepEqual(
        (await store.listOpen()).map((entry) => entry.queueId),
        [live.entry.queueId],
    );
    const next = await store.enqueue(intent("after"), now + 1);
    assert.ok(next.entry.sequence > total);
});

it("writes no index file", async (t) => {
    const { store, root } = await rig(t);
    const { entry } = await store.enqueue(intent("a"), 10);
    assert.deepEqual(await readdir(root), [`${entry.queueId}.json`]);
});
