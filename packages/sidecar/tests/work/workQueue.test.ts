import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { WorkQueueStore } from "../../src/work/workQueueStore.ts";

async function rig(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "work-queue-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { store: new WorkQueueStore(root), root };
}
const intent = (sourceEventId: string, workspace = "/a", sessionId = "s") => ({
    sourceEventId,
    kind: "scheduled" as const,
    title: "task",
    jobId: "job",
    workspace,
    sessionId,
    lane: "main" as const,
    payload: { text: sourceEventId },
});

it("persists queue identity before any execution attempt and deduplicates intent", async (t) => {
    const { store, root } = await rig(t);
    const a = await store.enqueue(intent("a"), 10);
    const again = await new WorkQueueStore(root).enqueue(intent("a"), 20);
    assert.equal(a.entry.queueId, again.entry.queueId);
    assert.equal(again.created, false);
    assert.equal(a.entry.work, undefined);
    assert.equal(a.entry.operation, undefined);
    assert.equal(a.entry.status, "queued");
    assert.notEqual((await store.enqueue(intent("a", "/b"))).entry.queueId, a.entry.queueId);
});

it("preserves FIFO even when the clock moves backwards", async (t) => {
    const { store } = await rig(t);
    const a = (await store.enqueue(intent("a"), 20)).entry;
    const b = (await store.enqueue(intent("b"), 10)).entry;
    assert.ok(a.sequence < b.sequence);
    assert.deepEqual(
        (await store.list()).map((entry) => entry.queueId),
        [a.queueId, b.queueId],
    );
});

it("cancels an unadmitted entry by revision and cannot admit it afterwards", async (t) => {
    const { store } = await rig(t);
    const a = (await store.enqueue(intent("a"))).entry;
    assert.equal((await store.cancel(a.queueId, a.revision + 1)).outcome, "revision_mismatch");
    assert.equal((await store.cancel(a.queueId, a.revision)).outcome, "accepted");
    assert.equal((await store.get(a.queueId))?.work, undefined);
    assert.equal(await store.claim(a.queueId, "owner"), undefined);
});

it("pins operation identity before admission and fences a stale driver", async (t) => {
    const { store } = await rig(t);
    const a = (await store.enqueue(intent("a"))).entry;
    const claimed = await store.claim(a.queueId, "one");
    assert.ok(claimed?.operation);
    const recovered = await store.claim(a.queueId, "two");
    assert.equal(recovered?.operation?.operationId, claimed.operation.operationId);
    assert.equal(
        await store.updateOwned(a.queueId, "one", (entry) => ({ ...entry, status: "completed" })),
        undefined,
    );
});
