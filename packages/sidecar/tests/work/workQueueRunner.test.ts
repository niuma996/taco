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

it("keeps cancellation pending until the recovered operation is terminal", async (t) => {
    let open = true;
    let recoveries = 0;
    const settled: string[] = [];
    const { store, queue } = await rig(t, {
        inspect: async () => (open ? { kind: "open" } : { kind: "settled", outcome: "aborted" }),
        cancel: async () => {}, // The unattached runtime defers its abort.
        recover: async () => {
            recoveries++;
        },
        settle: async (_entry, outcome) => {
            settled.push(outcome);
        },
    });
    const entry = (await store.enqueue(intent("cancel-open"))).entry;
    await store.claim(entry.queueId, "dead");
    const running = await store.updateOwned(entry.queueId, "dead", (value) => ({
        ...value,
        status: "running",
        operationAccepted: true,
        work: { workId: "w-original", attemptId: "a" },
    }));
    assert.ok(running);
    await store.cancel(running.queueId, running.revision);
    await queue.start();
    await queue.whenIdle();
    assert.deepEqual(settled, []);
    assert.equal((await store.get(entry.queueId))?.status, "running");
    assert.equal(recoveries, 1);
    open = false;
    await queue.pump();
    await queue.whenIdle();
    assert.deepEqual(settled, ["aborted"]);
    assert.equal((await store.get(entry.queueId))?.status, "cancelled");
});

it("does not cancel the fresh answer attempt through its old queue entry", async (t) => {
    let cancellations = 0;
    let settlements = 0;
    const { store, queue } = await rig(t, {
        readAttempt: async () => "fresh-answer",
        cancel: async () => {
            cancellations++;
        },
        settle: async () => {
            settlements++;
        },
    });
    const entry = (await store.enqueue(intent("answered"))).entry;
    await store.claim(entry.queueId, "dead");
    const waiting = await store.updateOwned(entry.queueId, "dead", (value) => ({
        ...value,
        status: "waiting",
        work: { workId: "w-original", attemptId: "old-question" },
    }));
    assert.ok(waiting);
    await store.cancel(waiting.queueId, waiting.revision);
    await queue.start();
    await queue.whenIdle();
    assert.equal(cancellations, 0);
    assert.equal(settlements, 0);
    assert.equal((await store.get(entry.queueId))?.status, "completed");
});

it("links and settles the Work when cancellation races its preparation", async (t) => {
    let begin!: () => void;
    const begun = new Promise<void>((resolve) => {
        begin = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let settled = false;
    const { store, queue } = await rig(t, {
        prepare: async () => {
            begin();
            await held;
            return { workId: "w-preparing", attemptId: "original" };
        },
        settle: async (entry, outcome) => {
            assert.equal(entry.work?.workId, "w-preparing");
            assert.equal(outcome, "aborted");
            settled = true;
        },
    });
    t.after(release);
    const entry = (await store.enqueue(intent("cancel-preparing"))).entry;
    const preparation = queue.prepare(entry.queueId);
    await begun;
    const current = await store.get(entry.queueId);
    assert.ok(current);
    await queue.cancel(entry.queueId, current.revision);
    await queue.start();
    // Let the cancellation pass inspect the operation before creation returns.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await preparation;
    await queue.whenIdle();
    assert.equal(settled, true, "a created Work must not be orphaned by the cancellation pass");
    const cancelled = await store.get(entry.queueId);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.work?.workId, "w-preparing");
});
