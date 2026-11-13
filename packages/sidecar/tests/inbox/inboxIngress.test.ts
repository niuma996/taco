import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { RPC, type RpcRequest } from "@taco-ai/protocol";
import { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import { DefaultChannelContext } from "../../src/channels/ingress.ts";
import type { ChannelInboundMessage } from "../../src/channels/types.ts";
import { InboxStore } from "../../src/inbox/inboxStore.ts";
import type { InboxBatch } from "../../src/inbox/inboxTypes.ts";
import { createLogger } from "../../src/lib/logger.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";

type SubmitInbound = (
    message: ChannelInboundMessage,
    target: { workspace: string; sessionId: string },
    batch: InboxBatch,
) => Promise<{ sessionId: string; failed?: boolean }>;

async function rig(t: TestContext, rejectPrompt = false, submitInbound?: SubmitInbound) {
    const root = await mkdtemp(join(tmpdir(), "inbox-ingress-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const inbox = new InboxStore(join(root, "inbox"));
    const requests: RpcRequest[] = [];
    const hook = {
        dispatchRpc: async (req: RpcRequest) => {
            requests.push(req);
            if (rejectPrompt && req.method === RPC.sessionPrompt)
                return {
                    id: req.id,
                    ok: false,
                    error: { code: "internal", message: "provider unavailable" },
                };
            return { id: req.id, ok: true, result: {} };
        },
    } as ServerRpcSurface;
    const router = await ConversationRouter.load(root);
    let binding: string | undefined = "account-a";
    const config = {
        get: () => undefined,
        set: async () => {},
        clear: async () => {},
        getDeliveryBinding: () => binding,
    };
    const ctx = new DefaultChannelContext(
        "wechat",
        hook,
        router,
        config,
        createLogger("inbox-test"),
        inbox,
        undefined,
        submitInbound,
    );
    const msg = (id: string): ChannelInboundMessage => ({
        channelId: "wechat",
        peerId: "p",
        chatId: "c",
        platformMessageId: id,
        text: id,
    });
    return {
        inbox,
        ctx,
        requests,
        msg,
        setBinding: (value: string | undefined) => {
            binding = value;
        },
        restart: () =>
            new DefaultChannelContext(
                "wechat",
                hook,
                router,
                config,
                createLogger("inbox-test"),
                new InboxStore(join(root, "inbox")),
                undefined,
                submitInbound,
            ),
    };
}

it("dispatches a real frozen batch without using stale receipt revisions", async (t) => {
    const { ctx, inbox, requests, msg } = await rig(t);
    const result = await ctx.ingress.submitBatch?.([msg("a"), msg("b")]);
    assert.ok(result?.batchId);
    assert.equal(requests.filter((req) => req.method === RPC.sessionPrompt).length, 1);
    assert.equal((await inbox.list()).length, 2);
});

it("hands the frozen batch and target to inbound Work without legacy prompt dispatch", async (t) => {
    const submitted: { message: ChannelInboundMessage; batch: InboxBatch }[] = [];
    const { ctx, inbox, requests, msg } = await rig(t, false, async (message, target, batch) => {
        submitted.push({ message, batch });
        return { sessionId: target.sessionId };
    });
    await ctx.ingress.submitBatch?.([msg("a"), msg("b")]);
    assert.equal(requests.filter((req) => req.method === RPC.sessionPrompt).length, 0);
    assert.equal(submitted.length, 1);
    const submittedBatch = submitted[0];
    assert.ok(submittedBatch);
    assert.equal(submittedBatch.batch.memberReceiptIds.length, 2);
    assert.equal(submittedBatch.message.platformMessageId, submittedBatch.batch.batchId);
    assert.equal((await inbox.getBatch(submittedBatch.batch.batchId))?.state, "submitted");
});

it("persists a single-message submit and does not dispatch its replay", async (t) => {
    const { ctx, inbox, requests, msg } = await rig(t);
    await ctx.ingress.submit(msg("a"));
    await ctx.ingress.submit(msg("a"));
    assert.equal((await inbox.list()).length, 1);
    assert.equal(requests.filter((req) => req.method === RPC.sessionPrompt).length, 1);
});

it("ignores a frozen member replay while dispatching new members of a later batch", async (t) => {
    const { ctx, requests, msg } = await rig(t);
    await ctx.ingress.submitBatch?.([msg("a"), msg("b")]);
    await ctx.ingress.submitBatch?.([msg("b"), msg("c")]);
    const prompts = requests.filter((req) => req.method === RPC.sessionPrompt);
    assert.equal(prompts.length, 2);
    assert.equal((prompts[1]?.params as { text?: string }).text, "c");
});

it("records a recoverable source before download and retries failed preparation after restart", async (t) => {
    const { ctx, inbox, msg, restart } = await rig(t);
    const prepare = async () => {
        assert.equal((await inbox.list())[0]?.status, "preparing");
        return undefined;
    };
    assert.equal(
        await ctx.ingress.prepare?.(msg("a"), { format: "test", data: { id: "a" } }, prepare),
        undefined,
    );
    assert.equal((await inbox.list())[0]?.status, "failed");
    const recovered: ChannelInboundMessage[] = [];
    await restart().ingress.recoverPrepared?.(
        "test",
        async (data) => {
            assert.deepEqual(data, { id: "a" });
            return msg("a");
        },
        (message) => recovered.push(message),
    );
    assert.equal(recovered.length, 1);
    assert.equal((await inbox.list())[0]?.status, "ready");
});

it("does not adopt a download from an old binding after account replacement", async (t) => {
    const { ctx, inbox, msg, setBinding } = await rig(t);
    await assert.rejects(
        ctx.ingress.prepare?.(msg("a"), { format: "test", data: {} }, async () => {
            setBinding("account-b");
            return msg("a");
        }) ?? Promise.reject(new Error("missing prepare")),
        /binding changed/,
    );
    assert.equal((await inbox.list())[0]?.bindingId, "account-a");
    assert.equal((await inbox.list())[0]?.status, "failed");
    setBinding(undefined);
    await assert.rejects(ctx.ingress.submit(msg("b")), /binding unavailable/);
});

it("records a rejected legacy dispatch as failure while acknowledging its durable receipt", async (t) => {
    const { ctx, inbox, msg } = await rig(t, true);
    const result = await ctx.ingress.submit(msg("a"));
    assert.ok(result.sessionId);
    assert.equal((await inbox.list())[0]?.status, "failed");
});

it("does not redispatch a legacy batch with an ambiguous pre-restart outcome", async (t) => {
    const { ctx, inbox, msg, requests, restart } = await rig(t);
    const message = msg("a");
    const receipt = (
        await inbox.accept({
            ...message,
            bindingId: "account-a",
            workspace: "im://wechat/p/c",
            receivedAt: 1,
        })
    ).receipt;
    const batch = (await inbox.freezeBatch(receipt.workspace, [receipt.receiptId])).batch;
    await inbox.claimBatch(batch.batchId, { workspace: receipt.workspace, sessionId: "original" });
    assert.equal((await restart().ingress.submit(message)).sessionId, "original");
    assert.equal(requests.filter((req) => req.method === RPC.sessionPrompt).length, 0);
    assert.ok(ctx.ingress);
});

it("replays a Work handoff interrupted before durable enqueue", async (t) => {
    const submitted: string[] = [];
    const { inbox, msg, restart } = await rig(t, false, async (_message, target, batch) => {
        submitted.push(batch.batchId);
        return target;
    });
    const receipt = (
        await inbox.accept({
            ...msg("crash"),
            bindingId: "account-a",
            workspace: "im://wechat/p/c",
            receivedAt: Date.now(),
        })
    ).receipt;
    const batch = (await inbox.freezeBatch(receipt.workspace, [receipt.receiptId])).batch;
    await inbox.claimBatch(
        batch.batchId,
        { workspace: receipt.workspace, sessionId: "original" },
        "work",
    );
    const restored = restart();
    await restored.ingress.recoverPrepared?.(
        "wechat",
        async () => undefined,
        () => {},
    );
    assert.deepEqual(submitted, [batch.batchId]);
    await restored.ingress.submit(msg("crash"));
    assert.deepEqual(submitted, [batch.batchId]);
    assert.equal((await inbox.getBatch(batch.batchId))?.state, "submitted");
});

it("does not replay legacy handoffs after upgrading to Work enqueue", async (t) => {
    let submitted = 0;
    const { inbox, msg, restart } = await rig(t, false, async (_message, target) => {
        submitted++;
        return target;
    });
    const receipt = (
        await inbox.accept({
            ...msg("legacy"),
            bindingId: "account-a",
            workspace: "im://wechat/p/c",
            receivedAt: Date.now(),
        })
    ).receipt;
    const batch = (await inbox.freezeBatch(receipt.workspace, [receipt.receiptId])).batch;
    await inbox.claimBatch(batch.batchId, { workspace: receipt.workspace, sessionId: "original" });
    await restart().ingress.recoverPrepared?.(
        "wechat",
        async () => undefined,
        () => {},
    );
    await restart().ingress.submit(msg("legacy"));
    assert.equal(submitted, 0);
});

it("retries a lost Work handoff response with the same durable queue identity", async (t) => {
    const { WorkQueueStore } = await import("../../src/work/workQueueStore.ts");
    const root = await mkdtemp(join(tmpdir(), "inbox-work-handoff-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const queue = new WorkQueueStore(join(root, "queue"));
    let loseResponse = true;
    const { ctx, inbox, msg, restart } = await rig(t, false, async (message, target, batch) => {
        await queue.enqueue({
            sourceEventId: `inbound:${batch.batchId}`,
            kind: "inbound",
            title: "handoff",
            workspace: target.workspace,
            sessionId: target.sessionId,
            lane: "main",
            payload: { text: message.text },
            sourceMemberIds: batch.memberReceiptIds,
            deliveryTarget: {
                channelId: "wechat",
                peerId: "p",
                chatId: "c",
                bindingId: "account-a",
            },
        });
        if (loseResponse) {
            loseResponse = false;
            throw new Error("response lost after enqueue");
        }
        return target;
    });
    await assert.rejects(ctx.ingress.submit(msg("lost-response")), /response lost/);
    const first = (await queue.list())[0];
    assert.ok(first);
    await restart().ingress.recoverPrepared?.(
        "wechat",
        async () => undefined,
        () => {},
    );
    assert.equal((await inbox.listBatches())[0]?.state, "submitted");
    assert.deepEqual(
        (await queue.list()).map((entry) => entry.queueId),
        [first.queueId],
    );
});
