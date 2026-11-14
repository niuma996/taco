import assert from "node:assert/strict";
import { test } from "node:test";
import { PushMethods, RPC, type RpcRequest, type RpcResponse } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("conversation-activity");

test("coalesces inbound activity within a bounded window and keeps validation read-only", async (t) => {
    const host = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const transport = new InMemoryTransport();
    await host.start(transport);
    t.after(() => host.stop());
    t.mock.method(host, "dispatchRpc", async (request: RpcRequest): Promise<RpcResponse> => {
        assert.ok(request.method === RPC.sessionCreate || request.method === RPC.sessionHistory);
        return { id: request.id, ok: true, result: {} };
    });
    const router = host.conversationRouterView;
    assert.ok(router);
    await router.route(host, "activity", "peer", "chat");
    transport.sent.length = 0;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const refreshes = () =>
        transport.sent.filter(
            (frame) => "method" in frame && frame.method === PushMethods.ConversationsChanged,
        );
    for (let i = 0; i < 10; i++) await router.route(host, "activity", "peer", "chat");
    const activity = router.listAll()[0].lastUsedAt;
    await router.route(host, "activity", "peer", "chat", undefined, { recordActivity: false });
    assert.equal(router.listAll()[0].lastUsedAt, activity);
    assert.equal(refreshes().length, 0);
    t.mock.timers.tick(80);
    await router.route(host, "activity", "peer", "chat");
    t.mock.timers.tick(20);
    assert.equal(refreshes().length, 1, "new traffic must not postpone the original deadline");
    assert.ok("id" in refreshes()[0] && refreshes()[0].id);
    const refresh = refreshes()[0];
    assert.ok("workspace" in refresh && refresh.workspace === "*");
    await router.route(host, "activity", "peer", "chat");
    t.mock.timers.tick(100);
    assert.equal(refreshes().length, 2, "continued traffic is announced in the next window");
    await router.route(host, "activity", "peer", "chat");
    await host.stop();
    t.mock.timers.tick(100);
    assert.equal(refreshes().length, 2, "shutdown discards pending activity notifications");
});

test("records inbound activity when it joins an in-flight validation-only lookup", async (t) => {
    const host = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    await host.start(new InMemoryTransport());
    t.after(() => host.stop());
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
        entered = resolve;
    });
    let block = false;
    t.mock.method(host, "dispatchRpc", async (request: RpcRequest): Promise<RpcResponse> => {
        if (block && request.method === RPC.sessionHistory) {
            entered();
            await blocked;
        }
        return { id: request.id, ok: true, result: {} };
    });
    const router = host.conversationRouterView;
    assert.ok(router);
    await router.route(host, "joined-activity", "peer", "chat");
    const before = router.listAll()[0].lastUsedAt;
    let activities = 0;
    router.on("activity", () => activities++);
    block = true;
    const validation = router.route(host, "joined-activity", "peer", "chat", undefined, {
        recordActivity: false,
    });
    await reading;
    const inbound = router.route(host, "joined-activity", "peer", "chat");
    release();
    await Promise.all([validation, inbound]);
    assert.ok(router.listAll()[0].lastUsedAt > before);
    assert.equal(activities, 1);
});
