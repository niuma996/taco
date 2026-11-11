import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { WorkQueue, type WorkQueueBackend } from "../../src/work/workQueue.ts";
import { WorkQueueStore } from "../../src/work/workQueueStore.ts";
import type { WorkQueueIntent } from "../../src/work/workQueueTypes.ts";

const intent = (id: string, workspace = "/a", sessionId = "s"): WorkQueueIntent => ({
    sourceEventId: id,
    workspace,
    sessionId,
    lane: "main",
    title: id,
    kind: "scheduled",
    jobId: "job",
    payload: { text: id },
});
const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "done" }],
    timestamp: 1,
};
async function rig(t: TestContext, overrides: Partial<WorkQueueBackend> = {}, budget = 4) {
    const root = await mkdtemp(join(tmpdir(), "work-queue-runner-"));
    const store = new WorkQueueStore(root);
    const calls: string[] = [];
    const backend: WorkQueueBackend = {
        prepare: async (entry) => ({ workId: `w-${entry.sourceEventId}`, attemptId: "a" }),
        readWork: async () => "running",
        inspect: async () => ({ kind: "missing" }),
        execute: async (entry, hooks) => {
            await hooks.beforeAccept();
            await hooks.afterAccept();
            calls.push(entry.sourceEventId);
            return message;
        },
        settle: async () => {},
        cancel: async () => {},
        recover: async () => {},
        ...overrides,
    };
    const queue = new WorkQueue(store, backend, {
        concurrency: budget,
        workspaceConcurrency: budget,
        pollMs: 10_000,
    });
    t.after(async () => {
        queue.stop();
        await queue.whenIdle();
        await rm(root, { recursive: true, force: true });
    });
    return { store, queue, calls, backend };
}

it("runs FIFO in one lane and admits other lanes within its budget", async (t) => {
    const { store, queue, calls } = await rig(t);
    await store.enqueue(intent("a"));
    await store.enqueue(intent("b"));
    await store.enqueue(intent("c", "/b"));
    await queue.start();
    await queue.whenIdle();
    await queue.pump();
    await queue.whenIdle();
    assert.ok(calls.indexOf("b") > calls.indexOf("a"));
    assert.equal(calls.length, 3);
    assert.ok((await store.list()).every((entry) => entry.status === "completed"));
});

it("recovers an already persisted result without calling the model again", async (t) => {
    const { store, queue, calls } = await rig(t, {
        inspect: async () => ({ kind: "settled", outcome: "completed", message }),
    });
    const e = (await store.enqueue(intent("a"))).entry;
    await store.claim(e.queueId, "dead");
    await queue.start();
    await queue.whenIdle();
    assert.equal(calls.length, 0);
    assert.equal((await store.get(e.queueId))?.status, "completed");
});

it("never accepts a replacement operation for an open or unconfirmed execution", async (t) => {
    let recoveries = 0;
    const { store, queue, calls } = await rig(t, {
        inspect: async () => ({ kind: "open" }),
        recover: async () => {
            recoveries++;
        },
    });
    const e = (await store.enqueue(intent("a"))).entry;
    const original = await store.claim(e.queueId, "dead");
    await queue.start();
    await queue.whenIdle();
    assert.equal(calls.length, 0);
    assert.equal(recoveries, 1);
    assert.equal(
        (await store.get(e.queueId))?.operation?.operationId,
        original?.operation?.operationId,
    );
    assert.equal((await store.get(e.queueId))?.status, "running");
});

it("does not let a queued cancellation or expired intent reach admission", async (t) => {
    const { store, queue, calls } = await rig(t);
    const a = (await store.enqueue(intent("a"))).entry;
    await store.cancel(a.queueId, a.revision);
    const b = (await store.enqueue({ ...intent("b"), deadlineAt: 1 })).entry;
    await queue.start();
    await queue.whenIdle();
    assert.equal(calls.length, 0);
    assert.equal((await store.get(a.queueId))?.work, undefined);
    assert.equal((await store.get(b.queueId))?.status, "failed");
});

it("parks human waiting without holding a global slot, while retaining lane order", async (t) => {
    const { store, queue, calls } = await rig(
        t,
        {
            execute: async (entry, hooks) => {
                await hooks.beforeAccept();
                await hooks.afterAccept();
                calls.push(entry.sourceEventId);
                return {
                    ...message,
                    role: "toolResult",
                    toolCallId: "q",
                    toolName: "askUser",
                    isError: false,
                    content: [],
                    details: { waiting: true, questions: [] },
                };
            },
            readWork: async (entry) =>
                calls.includes(entry.sourceEventId) ? "waiting" : "running",
        },
        1,
    );
    await store.enqueue(intent("a"));
    await store.enqueue(intent("b"));
    await store.enqueue(intent("c", "/b"));
    await queue.start();
    await queue.whenIdle();
    await queue.pump();
    await queue.whenIdle();
    assert.equal(calls.includes("b"), false);
    assert.equal(calls.includes("c"), true);
});

it("recovers the original operation when queue state fails after accept", async (t) => {
    let recovered = 0;
    let accepted = false;
    const { store, queue, calls } = await rig(t, {
        inspect: async () => ({ kind: accepted ? "open" : "missing" }),
        execute: async (entry, hooks) => {
            calls.push(entry.sourceEventId);
            await hooks.beforeAccept();
            accepted = true;
            await hooks.afterAccept();
            return message;
        },
        recover: async () => {
            recovered++;
        },
    });
    const original = store.updateOwned.bind(store);
    let failAcceptedWrite = true;
    store.updateOwned = (id, epoch, update) => {
        return original(id, epoch, (entry) => {
            const next = update(entry);
            if (failAcceptedWrite && next?.operationAccepted && !entry.operationAccepted) {
                failAcceptedWrite = false;
                throw new Error("disk write failed");
            }
            return next;
        });
    };
    await store.enqueue(intent("a"));
    await queue.start();
    await queue.whenIdle();
    assert.deepEqual(calls, ["a"]);
    assert.equal(recovered, 0);
    await queue.pump();
    await queue.whenIdle();
    assert.deepEqual(calls, ["a"]);
    assert.equal(recovered, 1);
    assert.equal((await store.list())[0]?.operationAccepted, true);
});
