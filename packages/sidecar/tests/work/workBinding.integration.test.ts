import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { asSessionId, type ImRoute } from "@taco-ai/protocol";
import { ChannelRegistry } from "../../src/channels/registry.ts";
import type { Channel, ChannelHandle } from "../../src/channels/types.ts";
import { claimManagedOperation } from "../../src/runtime/harness/operationExecution.ts";
import type { WorkOperationRef } from "../../src/work/workOperationTypes.ts";
import { WorkService } from "../../src/work/workService.ts";
import { resumeAttempt } from "../../src/work/workState.ts";

const route: ImRoute = { channelId: "channel", peerId: "peer", chatId: "chat" };

async function rig(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "taco-work-binding-"));
    const registry = new ChannelRegistry();
    let binding = "account-a";
    const sent: string[] = [];
    const handle: ChannelHandle = {
        getDeliveryBinding: () => binding,
        push: async () => {},
        close: async () => {},
        sendText: async (_target, text) => {
            sent.push(text);
            return { kind: "confirmed" };
        },
    };
    registry.register(
        "channel",
        {
            manifest: { name: "fake", version: "1", capabilities: { maxMessageLength: 100 } },
            start: async () => handle,
        } as Channel,
        handle,
    );
    const aborted: WorkOperationRef[] = [];
    const options = {
        root,
        instanceId: "i",
        channels: registry,
        resolveRoute: () => route,
        operations: {
            inspect: async () => ({ kind: "unknown" as const }),
            abort: async (ref: WorkOperationRef) => {
                aborted.push(ref);
                return { outcome: "accepted" as const, newlyRequested: true };
            },
        },
    };
    const service = new WorkService(options);
    t.after(async () => {
        service.stop();
        if (workId) await service.deliverer.forget(workId);
        await rm(root, { recursive: true, force: true });
    });
    const workId = await service.onLaunch({
        workspace: "im://channel/peer/chat",
        parentSessionId: asSessionId("parent"),
        parentToolCallId: "tool",
        childSessionId: asSessionId("child"),
        agentType: "e",
    });
    assert.ok(workId);
    return {
        root,
        registry,
        service,
        options,
        sent,
        workId,
        aborted,
        rebind: () => {
            binding = "account-b";
        },
    };
}

async function finish(service: WorkService, workId: string) {
    await service.controller.settle({
        workId,
        outcome: "completed",
        resultText: "private output",
        parentWillReply: false,
    });
    await service.deliverer.forget(workId);
}

it("keeps the launch identity when the channel was rebound before Work settled", async (t) => {
    const { service, workId, sent, rebind } = await rig(t);
    rebind();
    await finish(service, workId);
    const work = await service.store.get(workId);
    assert.equal(work?.deliveryTarget?.bindingId, "account-a");
    assert.equal(work?.delivery?.target.bindingId, "account-a");
    assert.equal(work?.status, "completed");
    assert.equal(work?.delivery?.status, "permanentFailure");
    assert.equal(work?.delivery?.lastError, "binding_changed");
    assert.deepEqual(sent, []);
    assert.deepEqual(await service.beginParentNotice(workId), { mode: "skip" });
    assert.equal((await service.retryDelivery(workId)).outcome, "not_retryable");
    assert.doesNotMatch(JSON.stringify((await service.get(workId)).work), /account-a|bindingId/);
});

it("checks the account again between chunks and preserves already confirmed progress", async (t) => {
    const { service, registry, sent, workId, rebind } = await rig(t);
    const send = registry.sendText.bind(registry);
    registry.sendText = async (...args) => {
        const result = await send(...args);
        if (result.kind === "confirmed") rebind();
        return result;
    };
    await service.controller.settle({
        workId,
        outcome: "completed",
        resultText: "private output".repeat(50),
        parentWillReply: false,
    });
    await service.deliverer.forget(workId);
    const work = await service.store.get(workId);
    assert.equal(sent.length, 1);
    assert.equal(work?.delivery?.confirmedChunks, 1);
    assert.equal(work?.delivery?.status, "permanentFailure");
    assert.equal(work?.delivery?.lastError, "binding_changed");
});

it("restarts against the same frozen binding without silently re-freezing the current account", async (t) => {
    const { service, options, workId, sent } = await rig(t);
    service.deliverer.stop();
    await service.controller.settle({
        workId,
        outcome: "completed",
        resultText: "private output",
        parentWillReply: false,
    });
    const restarted = new WorkService({ ...options, instanceId: "next" });
    t.after(async () => {
        restarted.stop();
        await restarted.deliverer.forget(workId);
    });
    await restarted.start();
    assert.equal((await restarted.get(workId)).work?.delivery?.status, "confirmed");
    assert.equal(sent.length, 1);
});

it("revalidates the notice immediately before acceptance and aborts its exact id if resume wins after acceptance", async (t) => {
    const { service, workId, aborted } = await rig(t);
    await finish(service, workId);
    const decision = await service.beginParentNotice(workId);
    assert.ok(decision.claimId);
    const claimId = decision.claimId;
    await service.runParentNotice(workId, claimId, "parent", async () => {
        const operation = claimManagedOperation("parent");
        assert.ok(operation);
        await operation.beforeAccept(claimId);
        await service.store.mutate(workId, (current) =>
            resumeAttempt({ ...current, status: "interrupted" }, { attemptId: "new", now: 10 }),
        );
        await operation.afterAccept(claimId);
    });
    assert.equal(aborted.length, 1);
    assert.equal(aborted[0]?.operationId, claimId);
    assert.equal(aborted[0]?.sessionId, "parent");
    assert.equal((await service.store.get(workId))?.attempt.attemptId, "new");
});
