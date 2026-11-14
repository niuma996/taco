import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import { WorkParentNotice } from "../../src/work/workParentNotice.ts";
import { WorkService } from "../../src/work/workService.ts";
import type { WorkRecord } from "../../src/work/workTypes.ts";

const parent = asSessionId("parent");
const target = { workspace: "/workspace", sessionId: parent };

async function rig(t: TestContext, capture = false) {
    const root = await mkdtemp(join(tmpdir(), "work-settlement-authority-"));
    const service = new WorkService({
        root,
        instanceId: "instance",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 1000,
            getDeliveryBinding: () => "binding",
        },
        resolveRoute: () =>
            capture ? { channelId: "im", peerId: "peer", chatId: "chat" } : undefined,
    });
    t.after(async () => {
        service.stop();
        await rm(root, { recursive: true, force: true });
    });
    const workId = await service.onLaunch({
        workspace: target.workspace,
        parentSessionId: parent,
        parentToolCallId: "launch",
        childSessionId: asSessionId("child"),
        agentType: "explorer",
        description: "Find the actual result",
    });
    assert.ok(workId);
    const work = await service.store.get(workId);
    assert.ok(work);
    return { service, root, workId, attemptId: work.attempt.attemptId };
}

const incoming = {
    outcome: "completed" as const,
    resultText: "pending text",
    partial: false,
    path: "/pending.txt",
};

it("does not mark a replacement attempt as reported when an old resume settles", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.store.mutate(workId, (work) => ({
        ...work,
        attempt: { attemptId: "replacement", startedAt: 20 },
    }));
    await service.onResumeSettle(asSessionId("child"), incoming, { workId, attemptId });
    const current = await service.store.get(workId);
    assert.equal(current?.status, "running");
    assert.equal(current?.parentNotice, undefined);
});

it("commits direct resume awareness in the terminal snapshot", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    const mutate = service.store.mutate.bind(service.store);
    service.store.mutate = async (...args) => {
        const result = await mutate(...args);
        if (result?.changed && result.record.status === "completed")
            assert.equal(result.record.parentNotice?.state, "completed");
        return result;
    };
    await service.onResumeSettle(asSessionId("child"), incoming, { workId, attemptId });
    const after = await service.store.get(workId);
    assert.equal(after?.status, "completed");
    assert.equal(after?.parentNotice?.state, "completed");
    assert.deepEqual(await service.pendingParentNotices(target), []);
});

it("returns the committed attempt and path after persisting a settlement", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    assert.deepEqual(await service.onSettle(workId, parent, incoming), {
        kind: "committed",
        attemptId,
        outcome: "completed",
        path: "/pending.txt",
    });
    assert.equal((await service.store.get(workId))?.status, "completed");
});

for (const [status, outcome] of [
    ["completed", "completed"],
    ["cancelled", "aborted"],
    ["failed", "error"],
    ["interrupted", "error"],
] as const) {
    it(`uses the existing ${status} outcome and result for duplicate settlement`, async (t) => {
        const { service, workId, attemptId } = await rig(t);
        await service.controller.settle({
            workId,
            attemptId,
            outcome,
            resultText: "actual text",
            path: "/actual.txt",
            parentWillReply: false,
        });
        if (status === "interrupted")
            await service.store.mutate(workId, (work) => ({ ...work, status }));
        assert.deepEqual(await service.onSettle(workId, parent, { ...incoming, attemptId }), {
            kind: "committed",
            attemptId,
            outcome,
            path: "/actual.txt",
        });
    });
}

it("uses the terminal snapshot won during settlement rather than the incoming outcome", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    const writeResult = service.store.writeResult.bind(service.store);
    service.store.writeResult = async (args) => {
        await service.store.mutate(workId, (work) => ({
            ...work,
            status: "cancelled",
            endedAt: 10,
            attempt: { ...work.attempt, endedAt: 10 },
        }));
        return writeResult(args);
    };
    assert.deepEqual(await service.onSettle(workId, parent, incoming), {
        kind: "committed",
        attemptId,
        outcome: "aborted",
    });
});

it("skips missing or replaced attempts without settling the replacement", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.store.mutate(workId, (work) => ({
        ...work,
        attempt: { attemptId: "replacement", startedAt: 20 },
    }));
    assert.deepEqual(await service.onSettle(workId, parent, { ...incoming, attemptId }), {
        kind: "superseded",
    });
    assert.equal((await service.store.get(workId))?.status, "running");
    assert.deepEqual(await service.onSettle("missing", parent, { ...incoming, attemptId }), {
        kind: "superseded",
    });
});

it("does not report a nonterminal same-attempt snapshot as committed", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.store.mutate(workId, (work) => ({ ...work, status: "waiting" }));
    assert.deepEqual(await service.onSettle(workId, parent, { ...incoming, attemptId }), {
        kind: "superseded",
    });
});

for (const failure of ["result", "snapshot"] as const) {
    it(`retries ${failure} persistence failure with the retained launch attempt`, async (t) => {
        const { service, workId, attemptId } = await rig(t);
        const writeResult = service.store.writeResult;
        const mutate = service.store.mutate;
        if (failure === "result")
            service.store.writeResult = async () => {
                throw new Error("result disk unavailable");
            };
        else
            service.store.mutate = async () => {
                throw new Error("snapshot disk unavailable");
            };
        assert.deepEqual(await service.onSettle(workId, parent, incoming), {
            kind: "retry",
            attemptId,
        });
        assert.equal((await service.store.get(workId))?.status, "running");
        service.store.writeResult = writeResult;
        service.store.mutate = mutate;
        assert.deepEqual(await service.onSettle(workId, parent, incoming), {
            kind: "committed",
            attemptId,
            outcome: "completed",
            path: "/pending.txt",
        });
    });
}

it("keeps the attempt identity on a settlement retry", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    service.controller.settle = async () => {
        throw new Error("settlement persistence unavailable");
    };
    assert.deepEqual(await service.onSettle(workId, parent, incoming), {
        kind: "retry",
        attemptId,
    });
});

it("retries a matching running attempt but permanently skips a resumed mismatch", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    const notices = new WorkParentNotice(service.store, "instance");
    assert.deepEqual(await notices.begin(workId, true, attemptId), {
        mode: "skip",
        retry: true,
    });
    assert.deepEqual(await notices.begin(workId, true, "resumed-attempt"), {
        mode: "skip",
    });
});

for (const capture of [false, true]) {
    it(`returns authoritative notice metadata for ${capture ? "capture" : "silent"} claims`, async (t) => {
        const { service, workId, attemptId } = await rig(t, capture);
        await service.controller.settle({
            workId,
            attemptId,
            outcome: "aborted",
            resultText: "actual result",
            path: "/actual.txt",
            parentWillReply: capture,
        });
        const decision = await service.beginParentNotice(
            workId,
            true,
            target,
            undefined,
            attemptId,
        );
        assert.equal(decision.mode, capture ? "capture" : "silent");
        assert.ok(decision.mode === "capture" || decision.mode === "silent");
        assert.deepEqual(decision.notice, {
            attemptId,
            subSessionId: "child",
            agentType: "explorer",
            description: "Find the actual result",
            outcome: "aborted",
            path: "/actual.txt",
        });
    });
}

it("rejects a stale expected attempt inside the claim mutation after a concurrent resume", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    const mutate = service.store.mutate.bind(service.store);
    let replacement = false;
    service.store.mutate = async (id, update) => {
        if (!replacement) {
            replacement = true;
            await mutate(id, (work) => ({
                ...work,
                status: "completed",
                attempt: { attemptId: "new-attempt", startedAt: 20, endedAt: 21 },
                parentNotice: undefined,
            }));
        }
        return mutate(id, update);
    };
    assert.deepEqual(await service.beginParentNotice(workId, true, target, undefined, attemptId), {
        mode: "skip",
    });
    assert.equal((await service.store.get(workId))?.parentNotice, undefined);
    const current = await service.beginParentNotice(workId, true, target, undefined, "new-attempt");
    assert.equal(current.mode, "silent");
});

it("freezes notice metadata from the claimed snapshot even when the Work changes afterward", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    const mutate = service.store.mutate.bind(service.store);
    service.store.mutate = async (id, update) => {
        const claimed = await mutate(id, update);
        if (claimed?.changed && claimed.record.parentNotice)
            await mutate(id, (work) => ({
                ...work,
                status: "failed",
                title: "replacement description",
                attempt: { attemptId: "new-attempt", startedAt: 20, endedAt: 21 },
                parentNotice: undefined,
            }));
        return claimed;
    };
    const decision = await service.beginParentNotice(workId, true, target, undefined, attemptId);
    assert.ok(decision.mode === "silent");
    assert.equal(decision.notice?.attemptId, attemptId);
    assert.equal(decision.notice?.outcome, "completed");
    assert.equal(decision.notice?.description, "Find the actual result");
});

it("retries claim persistence failure without consuming parent awareness", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    const mutate = service.store.mutate;
    service.store.mutate = async () => {
        throw new Error("claim disk unavailable");
    };
    assert.deepEqual(await service.beginParentNotice(workId, true, target, undefined, attemptId), {
        mode: "skip",
        retry: true,
    });
    service.store.mutate = mutate;
    assert.equal((await service.store.get(workId))?.parentNotice, undefined);
    assert.equal(
        (await service.beginParentNotice(workId, true, target, undefined, attemptId)).mode,
        "silent",
    );
});

it("keeps legacy claims compatible while enforcing expected attempts for direct admission", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    const notices = new WorkParentNotice(service.store, "instance");
    assert.deepEqual(await notices.begin(workId, true, "stale"), { mode: "skip" });
    assert.equal((await service.store.get(workId))?.parentNotice, undefined);
    const decision = await notices.begin(workId);
    assert.equal(decision.mode, "silent");
    assert.equal((await service.store.get(workId))?.parentNotice?.attemptId, attemptId);
});

it("recovers actual terminal notice snapshots after restart without pending records", async (t) => {
    const { service, root, workId, attemptId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    service.stop();
    const restarted = new WorkService({
        root,
        instanceId: "restarted",
        channels: {
            sendText: async () => ({ kind: "confirmed" as const }),
            maxMessageLength: () => 1000,
        },
        resolveRoute: () => undefined,
    });
    t.after(() => restarted.stop());
    for (const [status, outcome] of [
        ["completed", "completed"],
        ["failed", "error"],
        ["interrupted", "error"],
        ["cancelled", "aborted"],
    ] as const) {
        await restarted.store.mutate(workId, (work) => ({ ...work, status }));
        assert.deepEqual(await restarted.pendingParentNotices(target), [
            {
                workId,
                attemptId,
                subSessionId: "child",
                agentType: "explorer",
                description: "Find the actual result",
                outcome,
                path: "/pending.txt",
            },
        ]);
    }
    assert.equal((await restarted.store.get(workId))?.parentNotice, undefined);
});

it("scopes recovered parent notices by both workspace and parent session", async (t) => {
    const { service, workId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    const work = await service.store.get(workId);
    assert.ok(work);
    for (const [index, scope] of [
        { workspace: "/other-workspace" },
        { workspace: undefined },
        { parentSessionId: "other-parent" },
    ].entries()) {
        await service.store.createIfAbsent({
            ...work,
            ...scope,
            workId: `w-other-${index}`,
            sourceEventId: `other-source-${index}`,
        });
    }
    assert.deepEqual(
        (await service.pendingParentNotices(target)).map((notice) => notice.workId),
        [workId],
    );
    assert.deepEqual(
        await service.pendingParentNotices({ workspace: "/unrelated", sessionId: parent }),
        [],
    );
});

it("recovers only unclaimed terminal subagent notices with an eligible delivery", async (t) => {
    const { service, workId, attemptId } = await rig(t);
    await service.onSettle(workId, parent, incoming);
    const work = await service.store.get(workId);
    assert.ok(work);
    const claim = {
        attemptId,
        claimId: "old-claim",
        ownerInstanceId: "old-instance",
        state: "claimed" as const,
        claimedAt: 1,
    };
    const delivery = {
        deliveryId: "delivery",
        target: { channelId: "im", peerId: "peer", chatId: "chat" },
        status: "cancelled" as const,
        maxMessageLength: 1000,
        confirmedChunks: 0,
        attempts: 0,
        createdAt: 1,
    };
    const excluded: Partial<WorkRecord>[] = [
        { kind: "scheduled" },
        { kind: "inbound" },
        { status: "running" },
        { status: "waiting" },
        { childSessionId: undefined },
        { parentNotice: claim },
        { parentNotice: { ...claim, state: "completed", completedAt: 2 } },
        { delivery },
        { delivery: { ...delivery, status: "handedOff" } },
    ];
    for (const patch of excluded) {
        await service.store.mutate(workId, () => ({ ...work, ...patch }));
        assert.deepEqual(await service.pendingParentNotices(target), [], JSON.stringify(patch));
    }
    await service.store.mutate(workId, () => ({
        ...work,
        agentType: undefined,
        result: undefined,
        delivery: { ...delivery, status: "confirmed" },
    }));
    assert.deepEqual(await service.pendingParentNotices(target), [
        {
            workId,
            attemptId,
            subSessionId: "child",
            agentType: "",
            description: "Find the actual result",
            outcome: "completed",
        },
    ]);
});
