import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import type { AgentMessage } from "@taco-ai/protocol";
import { WorkQueueStore } from "../../src/work/workQueueStore.ts";
import type { WorkQueueEntry } from "../../src/work/workQueueTypes.ts";
import { WorkService } from "../../src/work/workService.ts";

const reply = (text: string): AgentMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1,
});
const waiting: AgentMessage = {
    role: "toolResult",
    toolCallId: "question-1",
    toolName: "askUser",
    isError: false,
    content: [],
    details: { waiting: true, questions: [] },
    timestamp: 1,
};
const deliveryTarget = {
    channelId: "wechat",
    peerId: "peer",
    chatId: "chat",
    bindingId: "account-a",
};
const inbound = (batchId: string, text = batchId) => ({
    batchId,
    memberReceiptIds: [`i-${batchId}`],
    title: text,
    workspace: "im://wechat/peer/chat",
    sessionId: "session",
    text,
    deliveryTarget,
});

async function rig(
    t: TestContext,
    execute: (entry: WorkQueueEntry) => Promise<AgentMessage> = async (entry) =>
        reply(`answer:${entry.payload.text}`),
    start = true,
) {
    const root = await mkdtemp(join(tmpdir(), "work-inbound-"));
    const calls: string[] = [];
    const sent: string[] = [];
    const service = new WorkService({
        root: join(root, "work"),
        instanceId: "instance",
        channels: {
            sendText: async (_channelId, _route, text) => {
                sent.push(text);
                return { kind: "confirmed" };
            },
            maxMessageLength: () => 1000,
            getDeliveryBinding: () => "account-a",
        },
        resolveRoute: () => deliveryTarget,
        operations: {
            inspect: async (ref) =>
                ref.operationId === "waiting-operation"
                    ? { kind: "settled" as const, outcome: "completed" as const, message: waiting }
                    : { kind: "missing" as const },
            abort: async () => ({ outcome: "accepted", newlyRequested: true }),
        },
        queue: {
            root: join(root, "queue"),
            execute: async (entry) => {
                calls.push(entry.sourceEventId);
                return execute(entry);
            },
            recover: async () => {},
        },
    });
    t.after(async () => {
        service.stop();
        for (const work of await service.store.list()) await service.deliverer.forget(work.workId);
        await rm(root, { recursive: true, force: true });
    });
    if (start) await service.start();
    return { root, service, calls, sent };
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 2000;
    for (;;) {
        const value = await read();
        if (accept(value)) return value;
        if (Date.now() > deadline)
            throw new Error(`condition did not become true: ${JSON.stringify(value)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

it("tracks one frozen batch as one inbound Work and delivers one final reply", async (t) => {
    const { service, calls, sent } = await rig(t);
    const first = await service.enqueueInbound(inbound("batch-a"));
    const work = await eventually(
        async () => (await service.store.list())[0],
        (value) => value?.status === "completed",
    );
    assert.equal(work.kind, "inbound");
    assert.deepEqual(work.sourceMemberIds, ["i-batch-a"]);
    assert.equal((await service.get(work.workId)).resultText, "answer:batch-a");
    await eventually(
        async () => sent.length,
        (length) => length === 1,
    );
    const duplicate = await service.enqueueInbound(inbound("batch-a"));
    assert.equal(duplicate.queueId, first.queueId);
    assert.deepEqual(calls, ["inbound:batch-a"]);
});

it("runs scheduled fires through the durable queue without legacy followUp", async (t) => {
    const { root, service, calls } = await rig(t);
    const reported: string[] = [];
    const pending = service.queueScheduled(
        {
            jobId: "job",
            fireId: "fire",
            title: "scheduled",
            workspace: "/workspace",
            sessionId: "scheduled-session",
            prompt: "run",
            createSession: true,
        },
        (workId) => reported.push(workId),
    );
    // `queueScheduled` resolves through the queue's own unref'd wake timer, so
    // awaiting it alone can leave the event loop empty. Poll the ledger with a
    // ref'd timer instead; once the entry is terminal the await returns at once.
    const queue = new WorkQueueStore(join(root, "queue"));
    await eventually(
        async () => (await queue.list())[0]?.status,
        (status) => status === "completed",
    );
    const result = await pending;
    assert.equal(result.status, "completed");
    assert.ok(result.workId);
    assert.deepEqual(reported, [result.workId]);
    assert.deepEqual(calls, ["job:job:fire"]);
    assert.equal((await service.store.get(result.workId))?.attempt.queueId !== undefined, true);
});

it("accepts self-fired work behind its caller without waiting for that lane", async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { root, service } = await rig(t, async () => {
        await held;
        return reply("caller finished");
    });
    t.after(release);
    await service.enqueueInbound(inbound("caller"));
    await eventually(
        () => service.store.list(),
        (works) => works.length === 1 && works[0]?.status === "running",
    );
    const request = {
        jobId: "self",
        fireId: "fire",
        title: "self",
        workspace: inbound("caller").workspace,
        sessionId: "session",
        prompt: "run later",
        createSession: false,
        waitForCompletion: false,
    };
    const pending = service.queueScheduled(request);
    const result = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300)),
    ]);
    assert.ok(result?.workId, "durable acceptance must return before the caller releases its lane");
    assert.equal((await service.store.get(result.workId))?.status, "running");
    release();
    const queue = new WorkQueueStore(join(root, "queue"));
    await eventually(
        () => queue.list(),
        (entries) => entries.length === 2 && entries.every((entry) => entry.status === "completed"),
    );
});

it("does not re-execute an existing legacy scheduled Work through the new queue", async (t) => {
    const { root, service, calls } = await rig(t, undefined, false);
    const legacy = await service.controller.startScheduled({
        sourceEventId: "job:job:fire",
        jobId: "job",
        title: "legacy",
        workspace: "/workspace",
        sessionId: "session",
    });
    const queue = new WorkQueueStore(join(root, "queue"));
    await queue.enqueue({
        sourceEventId: "job:job:fire",
        kind: "scheduled",
        title: "legacy",
        jobId: "job",
        workspace: "/workspace",
        sessionId: "session",
        lane: "main",
        payload: { text: "do not replay" },
    });
    await service.start();
    await eventually(
        async () => (await queue.list())[0]?.status,
        (status) => status === "failed",
    );
    assert.deepEqual(calls, []);
    assert.equal((await service.store.get(legacy.workId))?.status, "running");
});

it("continues the same Work for an explicit waiting answer", async (t) => {
    const { root, service, sent } = await rig(t, async (entry) =>
        entry.sourceEventId === "inbound:batch-a" ? waiting : reply("new"),
    );
    await service.enqueueInbound(inbound("batch-a"));
    const work = await eventually(
        async () => (await service.store.list())[0],
        (value) => value?.status === "waiting",
    );
    const previousAttempt = work.attempt.attemptId;
    assert.ok(work.workspace);
    await service.answerWaiting(
        { workspace: work.workspace, sessionId: work.parentSessionId },
        "question-1",
        async () => reply("continued"),
    );
    const continued = await service.store.get(work.workId);
    assert.equal(continued?.status, "completed");
    assert.notEqual(continued?.attempt.attemptId, previousAttempt);
    assert.equal(continued?.attempt.queueId, undefined);
    assert.equal((await service.get(work.workId)).resultText, "continued");
    await eventually(
        async () => sent.length,
        (length) => length === 1,
    );
    const queue = new WorkQueueStore(join(root, "queue"));
    const queued = (await queue.list())[0];
    assert.ok(queued?.operation && queued.driverEpoch);
    const driverEpoch = queued.driverEpoch;
    await queue.updateOwned(queued.queueId, driverEpoch, (entry) => {
        assert.ok(entry.operation);
        return {
            ...entry,
            status: "running",
            operationAccepted: true,
            operation: { ...entry.operation, operationId: "waiting-operation" },
        };
    });
    await eventually(
        async () => (await queue.list())[0]?.status,
        (status) => status === "completed",
    );
});

it("supersedes a waiting inbound Work when ordinary new input arrives", async (t) => {
    const { service } = await rig(t, async (entry) =>
        entry.sourceEventId === "inbound:batch-a" ? waiting : reply("new"),
    );
    await service.enqueueInbound(inbound("batch-a"));
    const first = await eventually(
        async () => (await service.store.list())[0],
        (value) => value?.status === "waiting",
    );
    await service.enqueueInbound(inbound("batch-b"));
    const all = await eventually(
        () => service.store.list(),
        (value) => value.length === 2 && value.every((work) => work.status !== "running"),
    );
    assert.equal(all.find((work) => work.workId === first.workId)?.status, "cancelled");
    assert.equal(all.find((work) => work.workId !== first.workId)?.status, "completed");
});

it("preserves its own question when the same inbound batch is replayed", async (t) => {
    const { service, calls } = await rig(t, async () => waiting);
    const first = await service.enqueueInbound(inbound("batch-a"));
    const work = await eventually(
        async () => (await service.store.list())[0],
        (value) => value?.status === "waiting",
    );
    const replayed = await service.enqueueInbound(inbound("batch-a"));
    assert.equal(replayed.queueId, first.queueId);
    const after = await service.store.get(work.workId);
    assert.equal(after?.status, "waiting");
    assert.equal(after?.attempt.attemptId, work.attempt.attemptId);
    assert.equal(after?.waiting?.toolCallId, "question-1");
    assert.equal(after?.attempt.cancelRequestedAt, undefined);
    assert.deepEqual(calls, ["inbound:batch-a"]);
});

it("retries superseding an older question after enqueue succeeded but cancellation failed", async (t) => {
    const { root, service } = await rig(t, async (entry) =>
        entry.sourceEventId === "inbound:batch-a" ? waiting : reply("new"),
    );
    await service.enqueueInbound(inbound("batch-a"));
    const old = await eventually(
        async () => (await service.store.list())[0],
        (value) => value?.status === "waiting",
    );
    const mutate = service.store.mutate.bind(service.store);
    let failCancellation = true;
    service.store.mutate = (id, update) =>
        mutate(id, (current) => {
            const next = update(current);
            if (id === old.workId && next?.status === "cancelled" && failCancellation) {
                failCancellation = false;
                throw new Error("cancellation snapshot failed");
            }
            return next;
        });
    await assert.rejects(service.enqueueInbound(inbound("batch-b")), /snapshot failed/);
    const queue = new WorkQueueStore(join(root, "queue"));
    const persisted = (await queue.list()).find(
        (entry) => entry.sourceEventId === "inbound:batch-b",
    );
    assert.ok(persisted, "new input must be durable before it supersedes the old question");
    const retried = await service.enqueueInbound(inbound("batch-b"));
    assert.equal(retried.queueId, persisted.queueId);
    await eventually(
        () => service.store.list(),
        (works) => works.length === 2 && works.every((work) => work.status !== "running"),
    );
    assert.equal((await service.store.get(old.workId))?.status, "cancelled");
});

it("does not let an older batch replay supersede a newer waiting question", async (t) => {
    const { service } = await rig(t, async () => waiting);
    await service.enqueueInbound(inbound("batch-a"));
    await eventually(
        () => service.store.list(),
        (works) => works[0]?.status === "waiting",
    );
    await service.enqueueInbound(inbound("batch-b"));
    const newer = await eventually(
        () => service.store.list(),
        (works) =>
            works.some(
                (work) => work.sourceEventId === "inbound:batch-b" && work.status === "waiting",
            ),
    );
    const question = newer.find((work) => work.sourceEventId === "inbound:batch-b");
    assert.ok(question);
    await service.enqueueInbound(inbound("batch-a"));
    assert.equal((await service.store.get(question.workId))?.status, "waiting");
});

it("cancels a persisted intent by queue revision before creating a Work", async (t) => {
    const { root, service, calls } = await rig(t, undefined, false);
    const queued = await service.enqueueInbound(inbound("batch-a"));
    const store = new WorkQueueStore(join(root, "queue"));
    assert.equal((await store.get(queued.queueId))?.revision, 0);
    assert.deepEqual(await service.cancelQueue(queued.queueId, 0), { outcome: "accepted" });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, []);
    assert.deepEqual(await service.store.list(), []);
});

it("settles a persisted operation result after restart without executing it again", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "work-inbound-recovery-"));
    const queueStore = new WorkQueueStore(join(root, "queue"));
    const queued = await queueStore.enqueue({
        sourceEventId: "inbound:batch-a",
        kind: "inbound",
        title: "batch-a",
        workspace: "im://wechat/peer/chat",
        sessionId: "session",
        lane: "main",
        payload: { text: "batch-a" },
        sourceMemberIds: ["i-batch-a"],
        deliveryTarget,
    });
    const claimed = await queueStore.claim(queued.entry.queueId, "dead-driver");
    assert.ok(claimed?.operation);
    let calls = 0;
    const service = new WorkService({
        root: join(root, "work"),
        instanceId: "new-instance",
        channels: {
            sendText: async () => ({ kind: "confirmed" }),
            maxMessageLength: () => 1000,
            getDeliveryBinding: () => "account-a",
        },
        resolveRoute: () => deliveryTarget,
        operations: {
            inspect: async () => ({
                kind: "settled",
                outcome: "completed",
                message: reply("recovered"),
            }),
            abort: async () => ({ outcome: "accepted", newlyRequested: true }),
        },
        queue: {
            root: join(root, "queue"),
            execute: async () => {
                calls++;
                return reply("duplicate");
            },
            recover: async () => {
                throw new Error("a settled result must not be driven");
            },
        },
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    await service.start();
    const work = await eventually(
        async () => (await service.store.list())[0],
        (value) => value?.status === "completed",
    );
    assert.equal(work.attempt.queueId, queued.entry.queueId);
    assert.equal((await service.get(work.workId)).resultText, "recovered");
    assert.equal(calls, 0);
    await eventually(
        async () => (await queueStore.get(queued.entry.queueId))?.status,
        (status) => status === "completed",
    );
    await eventually(
        async () => (await service.store.get(work.workId))?.delivery?.status,
        (status) => status === "confirmed",
    );
    await service.deliverer.forget(work.workId);
});

it("retains the attach-time cancellation guard until the recovered operation settles", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "work-cancel-restart-"));
    const queue = new WorkQueueStore(join(root, "queue"));
    let aborted = false;
    let recoveries = 0;
    let service!: WorkService;
    service = new WorkService({
        root: join(root, "work"),
        instanceId: "new",
        channels: { sendText: async () => ({ kind: "confirmed" }), maxMessageLength: () => 1000 },
        resolveRoute: () => undefined,
        operations: {
            inspect: async () =>
                aborted ? { kind: "settled", outcome: "aborted" } : { kind: "open" },
            abort: async () => ({ outcome: "deferred", newlyRequested: false }),
        },
        queue: {
            root: join(root, "queue"),
            execute: async () => assert.fail("cancelled operation must never be replaced"),
            recover: async (entry) => {
                assert.ok(entry.operation);
                assert.equal(
                    await service.cancellationRequested(
                        entry.workspace,
                        entry.sessionId,
                        entry.operation.operationId,
                    ),
                    true,
                );
                recoveries++;
            },
        },
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const entry = (
        await queue.enqueue({
            kind: "scheduled",
            sourceEventId: "job:cancel:fire",
            title: "cancel",
            jobId: "cancel",
            workspace: "/workspace",
            sessionId: "session",
            lane: "main",
            payload: { text: "run" },
        })
    ).entry;
    const claimed = await queue.claim(entry.queueId, "old");
    assert.ok(claimed?.operation);
    const work = await service.controller.startScheduled({
        sourceEventId: entry.sourceEventId,
        title: entry.title,
        jobId: "cancel",
        workspace: entry.workspace,
        sessionId: entry.sessionId,
        queueId: entry.queueId,
        operation: claimed.operation,
    });
    await service.store.mutate(work.workId, (current) => ({
        ...current,
        ownerInstanceId: "old",
        attempt: { ...current.attempt, operationAccepted: true },
    }));
    const running = await queue.updateOwned(entry.queueId, "old", (current) => ({
        ...current,
        status: "running",
        operationAccepted: true,
        work: { workId: work.workId, attemptId: work.attempt.attemptId },
    }));
    assert.ok(running);
    await service.cancelQueue(entry.queueId, running.revision);
    await service.start();
    await eventually(
        async () => recoveries,
        (value) => value === 1,
    );
    assert.equal((await service.store.get(work.workId))?.status, "running");
    assert.equal((await queue.get(entry.queueId))?.status, "running");
    aborted = true;
    await eventually(
        () => queue.get(entry.queueId),
        (value) => value?.status === "cancelled",
    );
    assert.equal((await service.store.get(work.workId))?.status, "cancelled");
});

it("keeps an accepted self-fire's eventual execution failure visible in Work", async (t) => {
    const { root, service } = await rig(t, async () => {
        throw new Error("provider failed after acceptance");
    });
    const result = await service.queueScheduled({
        jobId: "self",
        fireId: "failure",
        title: "self",
        workspace: "/workspace",
        sessionId: "session",
        prompt: "run",
        createSession: false,
        waitForCompletion: false,
    });
    assert.ok(result.workId);
    const queue = new WorkQueueStore(join(root, "queue"));
    await eventually(
        () => queue.list(),
        (entries) => entries[0]?.status === "failed",
    );
    assert.equal((await service.get(result.workId)).work?.status, "failed");
    const repeated = await service.queueScheduled({
        jobId: "self",
        fireId: "failure",
        title: "self",
        workspace: "/workspace",
        sessionId: "session",
        prompt: "run",
        createSession: false,
        waitForCompletion: false,
    });
    assert.equal(repeated.status, "failed");
});
