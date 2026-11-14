import assert from "node:assert/strict";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
    asWorkspaceId,
    ErrorCodes,
    makeImCwd,
    RPC,
    type RpcRequest,
    type RpcResponse,
} from "@taco-ai/protocol";
import type { ChannelInboundMessage } from "../../src/channels/types.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";
import type { QueueInboundWork } from "../../src/work/workService.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("inbox-cleanup-admission");

async function fixture(t: TestContext, channelId: string) {
    const workspace = asWorkspaceId(makeImCwd(channelId, "peer", "chat"));
    const root = join(home, "sessions", "im", channelId);
    const sessionCwd = join(root, "scratch");
    const repo = new JsonlSessionRepo({
        fileSystem: new NodeExecutionEnv({ cwd: sessionCwd }),
        sessionsRoot: root,
    });
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    let stopped = false;
    const close = async () => {
        if (stopped) return;
        stopped = true;
        await server.stop();
        await repo.close(harnessContext);
    };
    t.after(close);
    // Keep transcript ownership and cleanup real; no model or agent turn is needed.
    t.mock.method(server, "dispatchRpc", async (request: RpcRequest): Promise<RpcResponse> => {
        const params = request.params as { sessionId: string };
        if (request.method === RPC.sessionCreate) {
            const session = await repo.create(
                { id: params.sessionId, cwd: sessionCwd },
                harnessContext,
            );
            await session.close(harnessContext);
            return { id: request.id, ok: true, result: {} };
        }
        assert.equal(request.method, RPC.sessionHistory);
        const exists = (await repo.list({}, harnessContext)).some(
            (meta) => meta.id === params.sessionId,
        );
        return exists
            ? { id: request.id, ok: true, result: {} }
            : {
                  id: request.id,
                  ok: false,
                  error: { code: ErrorCodes.NotFound, message: "session deleted" },
              };
    });
    t.mock.method(server.channelRegistry, "getDeliveryBinding", () => "binding");
    const queued: QueueInboundWork[] = [];
    t.mock.method(server.work, "enqueueInbound", async (request: QueueInboundWork) => {
        // The refreshed route and queue write must share one admission window.
        await assert.rejects(server.cleanupWorkspace(workspace, false), /活动|任务/);
        queued.push(request);
        return { queueId: `queue-${queued.length}` };
    });
    await server.start(new NullTransport());
    const context = server.buildChannelContext(channelId);
    const message: ChannelInboundMessage = {
        channelId,
        peerId: "peer",
        chatId: "chat",
        platformMessageId: "message",
        text: "hello",
    };
    return { server, context, workspace, queued, message, close };
}

test("reroutes before enqueue when cleanup completes between routing and inbox claim", async (t) => {
    const f = await fixture(t, "cleanup-claim-race");
    const claim = f.server.inbox.claimBatch.bind(f.server.inbox);
    let deletedSessionId: string | undefined;
    t.mock.method(f.server.inbox, "claimBatch", async (...args: Parameters<typeof claim>) => {
        deletedSessionId = args[1].sessionId;
        assert.equal(
            f.server.conversationRouterView?.lookupByWorkspace(f.workspace)?.sessionId,
            deletedSessionId,
        );
        const cleaned = await f.server.cleanupWorkspace(f.workspace, false);
        assert.deepEqual(cleaned.failed, []);
        assert.ok(cleaned.removed.some((path) => path.endsWith(`_${deletedSessionId}.jsonl`)));
        assert.equal(f.server.conversationRouterView?.lookupByWorkspace(f.workspace), undefined);
        return claim(...args);
    });

    const result = await f.context.ingress.submit(f.message);
    assert.equal(f.queued.length, 1);
    assert.notEqual(f.queued[0]?.sessionId, deletedSessionId);
    assert.equal(result.sessionId, f.queued[0]?.sessionId);
    assert.equal(f.queued[0]?.workspace, f.workspace);
    assert.equal(
        f.server.conversationRouterView?.lookupByWorkspace(f.workspace)?.sessionId,
        result.sessionId,
    );
    const enqueued = f.queued[0];
    assert.ok(enqueued);
    assert.equal((await f.server.inbox.getBatch(enqueued.batchId))?.state, "submitted");
});

test("recovery replaces a persisted deleted target and submits its batch only once", async (t) => {
    const f = await fixture(t, "cleanup-stale-target");
    const router = f.server.conversationRouterView;
    assert.ok(router);
    const oldTarget = await router.route(f.server, f.message.channelId, "peer", "chat");
    const { receipt } = await f.server.inbox.accept({
        ...f.message,
        bindingId: "binding",
        workspace: f.workspace,
        receivedAt: Date.now(),
    });
    const { batch } = await f.server.inbox.freezeBatch(f.workspace, [receipt.receiptId]);
    await f.server.inbox.claimBatch(
        batch.batchId,
        {
            workspace: f.workspace,
            sessionId: oldTarget.sessionId,
        },
        "work",
    );
    assert.deepEqual((await f.server.inbox.getBatch(batch.batchId))?.target, oldTarget);
    assert.deepEqual((await f.server.cleanupWorkspace(f.workspace, false)).failed, []);
    await f.close();

    const restarted = await fixture(t, f.message.channelId);
    assert.equal(
        (await restarted.server.inbox.getBatch(batch.batchId))?.target?.sessionId,
        oldTarget.sessionId,
    );
    assert.ok(restarted.context.ingress.recoverPrepared);
    await restarted.context.ingress.recoverPrepared(
        "test",
        async () => undefined,
        () => {},
    );
    assert.equal(restarted.queued.length, 1);
    assert.notEqual(restarted.queued[0]?.sessionId, oldTarget.sessionId);
    assert.equal(restarted.queued[0]?.batchId, batch.batchId);
    assert.deepEqual(restarted.queued[0]?.memberReceiptIds, [receipt.receiptId]);
    assert.equal(
        restarted.queued[0]?.sessionId,
        restarted.server.conversationRouterView?.lookupByWorkspace(f.workspace)?.sessionId,
    );
    assert.equal((await restarted.server.inbox.getBatch(batch.batchId))?.state, "submitted");
    await restarted.context.ingress.submit(f.message);
    assert.equal(restarted.queued.length, 1);
});

test("records activity once per delivered batch including recovery with an existing route", async (t) => {
    const f = await fixture(t, "activity-recovery");
    const router = f.server.conversationRouterView;
    assert.ok(router);
    await router.route(f.server, f.message.channelId, "peer", "chat");
    let activity = 0;
    router.on("activity", () => activity++);
    await f.context.ingress.submit(f.message);
    assert.equal(activity, 1);
    const target = router.lookup(f.message.channelId, "peer", "chat");
    assert.ok(target);
    const before = router
        .listAll()
        .find((entry) => entry.channelId === f.message.channelId)?.lastUsedAt;
    const recovered = { ...f.message, platformMessageId: "recover-activity" };
    const { receipt } = await f.server.inbox.accept({
        ...recovered,
        bindingId: "binding",
        workspace: f.workspace,
        receivedAt: Date.now(),
    });
    const { batch } = await f.server.inbox.freezeBatch(f.workspace, [receipt.receiptId]);
    await f.server.inbox.claimBatch(
        batch.batchId,
        { workspace: f.workspace, sessionId: target.sessionId },
        "work",
    );
    await f.context.ingress.submit(recovered);
    assert.equal(activity, 2);
    assert.ok(
        (router.listAll().find((entry) => entry.channelId === f.message.channelId)?.lastUsedAt ??
            0) > (before ?? 0),
    );
});
