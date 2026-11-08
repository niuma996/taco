import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { claimManagedOperation } from "../../src/runtime/harness/operationExecution.ts";
import type { WorkOperationRef } from "../../src/work/workOperationTypes.ts";
import { WorkService } from "../../src/work/workService.ts";

async function rig(t: { after(fn: () => Promise<void>): void }) {
    const root = await mkdtemp(join(tmpdir(), "taco-work-execution-"));
    const aborted: WorkOperationRef[] = [];
    const service = new WorkService({
        root,
        instanceId: "i",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 1000,
        },
        resolveRoute: () => undefined,
        operations: {
            inspect: async () => ({ kind: "missing" }),
            abort: async (ref) => {
                aborted.push(ref);
                return { outcome: "accepted", newlyRequested: true };
            },
        },
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const work = await service.controller.start({
        sourceEventId: "s",
        workspace: "/a",
        parentSessionId: "parent",
        childSessionId: "child",
        agentType: "e",
        title: "test",
    });
    return { service, work, aborted, root };
}

it("persists execution identity before admission and cancels only the displayed attempt", async (t) => {
    const { service, work, aborted } = await rig(t);
    await service.run(work.workId, "child", async (attemptId) => {
        assert.equal(attemptId, work.attempt.attemptId);
        const operation = claimManagedOperation("child");
        assert.ok(operation);
        await operation.beforeAccept(operation.operationId);
        await operation.afterAccept(operation.operationId);
        const record = await service.store.get(work.workId);
        assert.equal(record?.attempt.operation?.sessionId, "child");
        assert.equal(
            (await service.cancel(work.workId, "old-attempt")).outcome,
            "attempt_mismatch",
        );
        assert.equal(aborted.length, 0);
        assert.equal((await service.cancel(work.workId, attemptId)).newlyRequested, true);
        assert.equal((await service.cancel(work.workId, attemptId)).newlyRequested, false);
    });
    assert.equal(aborted[0]?.sessionId, "child");
});

it("cancels a not-yet-admitted intent without allowing it to start later", async (t) => {
    const { service, work } = await rig(t);
    await service.run(work.workId, "child", async (attemptId) => {
        const operation = claimManagedOperation("child");
        assert.ok(operation);
        assert.equal((await service.cancel(work.workId, attemptId)).outcome, "accepted");
        await assert.rejects(operation.beforeAccept(operation.operationId), /cancel/);
    });
});

it("keeps precise cancellation unsupported for legacy running records", async (t) => {
    const { service, work, aborted } = await rig(t);
    assert.equal(
        (await service.cancel(work.workId, work.attempt.attemptId)).outcome,
        "unsupported",
    );
    assert.equal(aborted.length, 0);
});

it("binds the answer operation in the same write that resumes its attempt", async (t) => {
    const { service, work } = await rig(t);
    await service.controller.waitForInput(work.workId, {
        toolName: "askUser",
        toolCallId: "q",
        sessionId: "child",
    });
    let runs = 0;
    const run = async () => {
        runs++;
        return { role: "assistant" as const, content: [], timestamp: 1 };
    };
    const context = {
        operationId: "answer-operation",
        bind: async () => {
            const active = await service.store.get(work.workId);
            assert.equal(active?.status, "running");
            assert.equal(active.attempt.operation?.operationId, "answer-operation");
            throw new Error("receipt write failed");
        },
    };
    await assert.rejects(
        service.answerWaiting({ workspace: "/a", sessionId: "child" }, "q", run, context),
        /receipt write failed/,
    );
    assert.equal(runs, 0);
    await service.answerWaiting({ workspace: "/a", sessionId: "child" }, "q", run, {
        ...context,
        bind: async () => {},
    });
    assert.equal(runs, 1);
    assert.equal((await service.get(work.workId)).work?.status, "completed");
});

it("cancels waiting without aborting another operation and rejects its late answer", async (t) => {
    const { service, work, aborted } = await rig(t);
    await service.controller.waitForInput(work.workId, {
        toolCallId: "q",
        toolName: "askUser",
        sessionId: "child",
    });
    assert.equal((await service.cancel(work.workId, work.attempt.attemptId)).outcome, "accepted");
    assert.equal((await service.get(work.workId)).work?.status, "cancelled");
    assert.equal(aborted.length, 0);
    let ran = false;
    await assert.rejects(
        service.answerWaiting({ workspace: "/a", sessionId: "child" }, "q", async () => {
            ran = true;
            return { role: "assistant", content: [], timestamp: 1 };
        }),
        /cancelled/,
    );
    assert.equal(ran, false);
    await service.delete(work.workId);
    await assert.rejects(
        service.answerWaiting({ workspace: "/a", sessionId: "child" }, "q", async () => {
            ran = true;
            return { role: "assistant", content: [], timestamp: 1 };
        }),
        /cancelled/,
    );
    assert.equal(ran, false);
});

it("does not claim exact cancellation for work merged into a shared queue", async (t) => {
    const { service, work } = await rig(t);
    await service.run(work.workId, "child", async () => {});
    await service.onFireQueued(work.workId, "queue-entry");
    assert.equal((await service.get(work.workId)).work?.canCancel, false);
    assert.equal(
        (await service.cancel(work.workId, work.attempt.attemptId)).outcome,
        "unsupported",
    );
});

it("keeps an operation's deferred cancel intent until the unified recovery path applies it", async (t) => {
    const { service, work } = await rig(t);
    await service.run(work.workId, "child", async () => {});
    await service.store.mutate(work.workId, (current) => ({
        ...current,
        ownerInstanceId: "previous",
    }));
    assert.equal((await service.cancel(work.workId, work.attempt.attemptId)).outcome, "accepted");
    const ref = (await service.store.get(work.workId))?.attempt.operation;
    assert.ok(ref);
    assert.equal(await service.cancellationRequested("/a", "child", ref.operationId), true);
    assert.equal(await service.cancellationRequested("/a", "other", ref.operationId), false);
});

it("repairs a completed operation at restart without driving or rerunning it", async (t) => {
    const { service, work, root } = await rig(t);
    await service.run(work.workId, "child", async () => {});
    const restarted = new WorkService({
        root,
        instanceId: "next",
        channels: { sendText: async () => ({ kind: "confirmed" }), maxMessageLength: () => 1000 },
        resolveRoute: () => undefined,
        operations: {
            inspect: async () => ({
                kind: "settled",
                outcome: "completed",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "recovered result" }],
                    timestamp: 1,
                },
            }),
            abort: async () => {
                throw new Error("recovery must not cancel or drive");
            },
        },
    });
    t.after(async () => {
        restarted.stop();
    });
    await restarted.start();
    assert.equal((await restarted.get(work.workId)).work?.status, "completed");
    assert.equal((await restarted.get(work.workId)).resultText, "recovered result");
});

it("ignores an old resume settle after a newer attempt has started", async (t) => {
    const { service, work } = await rig(t);
    await service.controller.waitForInput(work.workId, {
        toolCallId: "q",
        toolName: "askUser",
        sessionId: "child",
    });
    const old = await service.onResumeStart("child" as never);
    assert.ok(old);
    await service.controller.waitForInput(work.workId, {
        toolCallId: "q2",
        toolName: "askUser",
        sessionId: "child",
    });
    const next = await service.onResumeStart("child" as never);
    assert.ok(next);
    await service.onResumeSettle(
        "child" as never,
        { outcome: "completed", resultText: "old", partial: false },
        old,
    );
    assert.equal((await service.store.get(work.workId))?.status, "running");
    assert.equal((await service.store.get(work.workId))?.attempt.attemptId, next.attemptId);
});

it("ignores a late scheduled settle after its waiting answer created a new attempt", async (t) => {
    const { service } = await rig(t);
    const workId = await service.onFire({
        jobId: "j",
        fireId: "f",
        workspace: "/a",
        sessionId: "s",
        title: "scheduled",
    });
    assert.ok(workId);
    await service.onFireSettle(workId, {
        outcome: "waiting",
        waiting: { toolName: "askUser", toolCallId: "q", sessionId: "s" },
    });
    await service.answerWaiting({ workspace: "/a", sessionId: "s" }, "q", async () => {
        await service.onFireSettle(workId, { outcome: "completed", replyText: "old fire" });
        assert.equal((await service.store.get(workId))?.status, "running");
        return { role: "assistant", content: [{ type: "text", text: "new answer" }], timestamp: 1 };
    });
    assert.equal((await service.get(workId)).resultText, "new answer");
});
