import assert from "node:assert/strict";
import { test } from "node:test";
import { type RpcRequest, type RpcResponse, SIDECAR_PROTOCOL_VERSION } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { ClientSinkRegistry } from "../../src/server/clientSinkRegistry.ts";
import { ConnectionServer } from "../../src/server/connectionServer.ts";
import { registerAdhocMethod } from "../../src/server/methodRegistry.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";

async function request(transport: InMemoryTransport, req: RpcRequest): Promise<RpcResponse> {
    const count = transport.sent.length + 1;
    transport.simulateRequest(JSON.stringify(req));
    await transport.waitForPushCount(count);
    const response = [...transport.sent]
        .reverse()
        .find((frame) => "ok" in frame && frame.id === req.id);
    assert.ok(response && "ok" in response);
    return response;
}
const initialize = (id: string): RpcRequest => ({
    id,
    method: "initialize",
    params: { protocolVersion: SIDECAR_PROTOCOL_VERSION, clientCapabilities: { uiLocale: "zh" } },
});

test("connections initialize independently, share commands, and survive peer disconnect", async () => {
    let calls = 0;
    const sinks = new ClientSinkRegistry();
    const host = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        clientSinkRegistry: sinks,
    });
    registerAdhocMethod("test.sharedCommand", false, async () => ({ calls: ++calls }), {
        command: true,
    });
    await host.start(new NullTransport(), []);
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    const first = new ConnectionServer(host, a, sinks);
    const second = new ConnectionServer(host, b, sinks);
    await Promise.all([first.start(), second.start()]);
    try {
        assert.equal((await request(a, initialize("init-a"))).ok, true);
        const denied = await request(b, {
            id: "before-init",
            method: "workspace.list",
            params: {},
        });
        assert.ok(!denied.ok && denied.error.code === "not_initialized");
        assert.equal((await request(b, initialize("init-b"))).ok, true);
        const cmd = { method: "test.sharedCommand", commandId: "same-command", params: {} };
        assert.equal((await request(a, { id: "a", ...cmd })).ok, true);
        assert.equal((await request(b, { id: "b", ...cmd })).ok, true);
        assert.equal(calls, 1);
        assert.equal(
            a.sent.some((frame) => frame.id === "b"),
            false,
        );
        await first.stop();
        assert.equal(
            (await request(b, { id: "after-close", method: "workspace.list", params: {} })).ok,
            true,
        );
        assert.equal(sinks.hasClient(), true);
    } finally {
        await Promise.all([first.stop(), second.stop()]);
        await host.stop();
    }
});

test("incompatible initialization never opens a connection", async () => {
    const host = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const transport = new InMemoryTransport();
    const connection = new ConnectionServer(host, transport, new ClientSinkRegistry());
    await connection.start();
    try {
        const bad = await request(transport, {
            id: "bad",
            method: "initialize",
            params: { protocolVersion: { major: 999, minor: 0 } },
        });
        assert.ok(!bad.ok && bad.error.code === "incompatible_protocol");
        const denied = await request(transport, {
            id: "no-init",
            method: "workspace.list",
            params: {},
        });
        assert.ok(!denied.ok && denied.error.code === "not_initialized");
    } finally {
        await connection.stop();
    }
});

test("two clients reuse one workspace and receive one sequenced event after peer disconnect", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { asSessionId, asWorkspaceId } = await import("@taco-ai/protocol");
    const cwd = asWorkspaceId(await mkdtemp(join(tmpdir(), "taco-shared-runtime-")));
    const sinks = new ClientSinkRegistry();
    const host = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        clientSinkRegistry: sinks,
    });
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    const first = new ConnectionServer(host, a, sinks);
    const second = new ConnectionServer(host, b, sinks);
    await host.start(new NullTransport(), []);
    await Promise.all([first.start(), second.start()]);
    try {
        await request(a, initialize("init-a"));
        await request(b, initialize("init-b"));
        const ensured = await Promise.all([
            request(a, { id: "ensure-a", method: "workspace.ensure", params: { cwd } }),
            request(b, { id: "ensure-b", method: "workspace.ensure", params: { cwd } }),
        ]);
        assert.ok(ensured.every((result) => result.ok));
        const workspace = await host.ensureWorkspace(cwd);
        assert.deepEqual(host.workspaceIds(), [cwd]);
        const sessionId = asSessionId("shared-session");
        workspace.emit("session.renamed", { sessionId, name: "First" });
        const eventA = a.sent.find(
            (frame) => "method" in frame && frame.method === "session.renamed",
        );
        const eventB = b.sent.find(
            (frame) => "method" in frame && frame.method === "session.renamed",
        );
        assert.ok(eventA && eventB);
        assert.deepEqual(eventA, eventB);
        assert.equal("seq" in eventA && eventA.seq, 1);
        await first.stop();
        assert.equal(await host.ensureWorkspace(cwd), workspace);
        workspace.emit("session.renamed", { sessionId, name: "Second" });
        const next = [...b.sent]
            .reverse()
            .find((frame) => "method" in frame && frame.method === "session.renamed");
        assert.equal(next && "seq" in next && next.seq, 2);
        assert.equal(
            a.sent.filter((frame) => "method" in frame && frame.method === "session.renamed")
                .length,
            1,
        );
        assert.equal(host.getSessionLastSeq(cwd, sessionId), 2);
    } finally {
        await Promise.all([first.stop(), second.stop()]);
        await host.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("reconnection refreshes resolved config without rebuilding unchanged workspaces", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { asWorkspaceId } = await import("@taco-ai/protocol");
    const { resolveConfig } = await import("../../src/config/config.ts");
    const cwd = asWorkspaceId(await mkdtemp(join(tmpdir(), "taco-config-refresh-")));
    let config = resolveConfig();
    const host = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => config,
    });
    await host.start(new NullTransport(), []);
    const sinks = new ClientSinkRegistry();
    const transport = new InMemoryTransport();
    const connection = new ConnectionServer(host, transport, sinks);
    try {
        const original = await host.ensureWorkspace(cwd);
        config = {
            ...config,
            defaultProvider: "custom:refresh",
            defaultModel: "model",
            customProviders: [
                {
                    id: "custom:refresh",
                    name: "Refresh",
                    api: "chatcomplete",
                    baseUrl: "https://example.invalid/v1",
                    models: [{ id: "model", contextWindow: 128000 }],
                },
            ],
        };
        await connection.start();
        const after = await host.ensureWorkspace(cwd);
        assert.equal(after, original);
        assert.equal(after.defaultModel?.id, "model");
        config = {
            ...config,
            customProviders: config.customProviders?.map((provider) => ({
                ...provider,
                models: [{ id: "model", contextWindow: 654321 }],
            })),
        };
        assert.equal(await host.ensureWorkspace(cwd), original);
        assert.equal(original.defaultModel?.contextWindow, 654321);
        config = { ...config, memoryEnabled: false };
        const next = await host.ensureWorkspace(cwd);
        assert.notEqual(next, original);
        assert.equal(await host.ensureWorkspace(cwd), next);
    } finally {
        await connection.stop();
        await host.stop();
        await rm(cwd, { recursive: true, force: true });
    }
});

test("a malformed external config does not block reconnection with the last valid runtime", async () => {
    const { resolveConfig } = await import("../../src/config/config.ts");
    const config = resolveConfig();
    let invalid = false;
    const host = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        resolveConfig: () => {
            if (invalid) throw new Error("invalid disk configuration");
            return config;
        },
    });
    invalid = true;
    const transport = new InMemoryTransport();
    const connection = new ConnectionServer(host, transport, new ClientSinkRegistry());
    try {
        await connection.start();
        assert.equal((await request(transport, initialize("fallback"))).ok, true);
    } finally {
        await connection.stop();
    }
});
