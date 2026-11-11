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
import { createLogger } from "../../src/lib/logger.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";

async function rig(t: TestContext, rejectPrompt = false) {
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
