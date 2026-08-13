import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RpcResponse } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { registerMethod } from "../../src/server/methodRegistry.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";

let probeCalls = 0;
registerMethod(
    "test.probe",
    false,
    async () => {
        probeCalls++;
        return { ok: true };
    },
    { command: true },
);

function initializeFrame(id: string, minor = 0): string {
    return JSON.stringify({
        id,
        method: "initialize",
        params: {
            protocolVersion: { major: 1, minor },
            clientCapabilities: { uiLocale: "en" },
        },
    });
}

/** Boots a server on an in-memory transport and drops the hello frame. */
async function bootServer(): Promise<{ server: SidecarServer; transport: InMemoryTransport }> {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    const transport = new InMemoryTransport();
    await server.start(transport, []);
    return { server, transport };
}

/** Drives one request through the stdio boundary and returns its response. */
async function sendLine(transport: InMemoryTransport, raw: string): Promise<RpcResponse> {
    const before = transport.sent.length;
    transport.simulateRequest(raw);
    const frames = await transport.waitForPushCount(before + 1);
    return frames[frames.length - 1] as RpcResponse;
}

describe("initialize handshake (stdio boundary)", () => {
    it("rejects ordinary RPC before initialize", async () => {
        probeCalls = 0;
        const { transport } = await bootServer();
        const resp = await sendLine(
            transport,
            JSON.stringify({ id: "req-1", method: "test.probe", commandId: "c1", params: {} }),
        );
        assert.equal(resp.ok, false);
        if (!resp.ok) assert.equal(resp.error.code, "not_initialized");
        assert.equal(probeCalls, 0, "handler must not run before initialize");
    });

    it("returns server version, capabilities, and protocol version", async () => {
        const { transport } = await bootServer();
        const resp = await sendLine(transport, initializeFrame("init-1"));
        assert.equal(resp.ok, true);
        if (!resp.ok) return;
        const result = resp.result as {
            serverVersion: string;
            serverCapabilities: { methods: string[]; pushes: string[] };
            protocolVersion: { major: number; minor: number };
        };
        assert.equal(typeof result.serverVersion, "string");
        assert.ok(result.serverCapabilities.methods.includes("initialize"));
        assert.ok(result.serverCapabilities.pushes.includes("sidecar.hello"));
        assert.deepEqual(result.protocolVersion, { major: 1, minor: 0 });
    });

    it("lets ordinary RPC through after initialize", async () => {
        probeCalls = 0;
        const { transport } = await bootServer();
        await sendLine(transport, initializeFrame("init-1"));
        const probe = await sendLine(
            transport,
            JSON.stringify({ id: "p1", method: "test.probe", commandId: "pc1", params: {} }),
        );
        assert.equal(probe.ok, true);
        assert.equal(probeCalls, 1);
    });

    it("rejects incompatible client major and stays uninitialized", async () => {
        const { transport } = await bootServer();
        const resp = await sendLine(
            transport,
            JSON.stringify({
                id: "bad",
                method: "initialize",
                params: { protocolVersion: { major: 0, minor: 9 }, clientCapabilities: {} },
            }),
        );
        assert.equal(resp.ok, false);
        if (!resp.ok) assert.equal(resp.error.code, "incompatible_protocol");
        const blocked = await sendLine(
            transport,
            JSON.stringify({ id: "b1", method: "test.probe", commandId: "bc1", params: {} }),
        );
        assert.equal(blocked.ok, false);
        if (!blocked.ok) assert.equal(blocked.error.code, "not_initialized");
    });

    it("rejects a client minor newer than the server", async () => {
        const { transport } = await bootServer();
        const resp = await sendLine(transport, initializeFrame("init-future", 1));
        assert.equal(resp.ok, false);
        if (!resp.ok) assert.equal(resp.error.code, "incompatible_protocol");
    });

    it("accepts an older compatible client minor", async () => {
        probeCalls = 0;
        const { transport } = await bootServer();
        const init = await sendLine(transport, initializeFrame("init-old", 0));
        assert.equal(init.ok, true);
        const probe = await sendLine(
            transport,
            JSON.stringify({ id: "p1", method: "test.probe", commandId: "pc1", params: {} }),
        );
        assert.equal(probe.ok, true);
        assert.equal(probeCalls, 1);
    });

    it("rejects a malformed protocolVersion", async () => {
        const { transport } = await bootServer();
        const resp = await sendLine(
            transport,
            JSON.stringify({
                id: "bad",
                method: "initialize",
                params: { protocolVersion: { major: "1", minor: 0 }, clientCapabilities: {} },
            }),
        );
        assert.equal(resp.ok, false);
        if (!resp.ok) assert.equal(resp.error.code, "invalid_params");
    });

    it("is repeatable", async () => {
        const { transport } = await bootServer();
        assert.equal((await sendLine(transport, initializeFrame("init-1"))).ok, true);
        assert.equal((await sendLine(transport, initializeFrame("init-2"))).ok, true);
    });

    it("guard runs before command idempotency", async () => {
        probeCalls = 0;
        const { transport } = await bootServer();
        // Pre-init request carries a commandId; it must be rejected without
        // leaving a commandRecords entry.
        const blocked = await sendLine(
            transport,
            JSON.stringify({ id: "pre", method: "test.probe", commandId: "shared", params: {} }),
        );
        assert.equal(blocked.ok, false);
        await sendLine(transport, initializeFrame("init-1"));
        // Same commandId now executes (no command_id_conflict) — proof the
        // pre-init attempt never recorded.
        const after = await sendLine(
            transport,
            JSON.stringify({ id: "post", method: "test.probe", commandId: "shared", params: {} }),
        );
        assert.equal(after.ok, true);
        assert.equal(probeCalls, 1);
    });

    it("stop() resets initialization state", async () => {
        const { server, transport } = await bootServer();
        await sendLine(transport, initializeFrame("init-1"));
        assert.equal(
            (
                await sendLine(
                    transport,
                    JSON.stringify({ id: "ok", method: "test.probe", commandId: "k", params: {} }),
                )
            ).ok,
            true,
        );
        await server.stop();
        await server.start(transport, []);
        const afterStop = await sendLine(
            transport,
            JSON.stringify({ id: "blocked", method: "test.probe", commandId: "k2", params: {} }),
        );
        assert.equal(afterStop.ok, false);
        if (!afterStop.ok) assert.equal(afterStop.error.code, "not_initialized");
    });
});

describe("in-process callers are exempt from the handshake", () => {
    it("dispatchRpc works without initialize (headless / IM-only sidecar)", async () => {
        probeCalls = 0;
        const { server } = await bootServer();
        // No initialize. IM channel ingress, ConversationRouter and the memory
        // self-RPC tool all reach the server this way and have no client to
        // handshake — gating them would silently break headless sidecars.
        const resp = await server.dispatchRpc({
            id: "in-proc",
            method: "test.probe",
            commandId: "ip1",
            params: {},
        });
        assert.equal(resp.ok, true, "in-process dispatchRpc must not be gated");
        assert.equal(probeCalls, 1);
    });

    it("in-process commandId dedup still applies without initialize", async () => {
        probeCalls = 0;
        const { server } = await bootServer();
        const first = await server.dispatchRpc({
            id: "a",
            method: "test.probe",
            commandId: "dup",
            params: {},
        });
        const retry = await server.dispatchRpc({
            id: "b",
            method: "test.probe",
            commandId: "dup",
            params: {},
        });
        assert.equal(first.ok, true);
        assert.equal(retry.ok, true);
        assert.equal(probeCalls, 1, "identical commandId must execute once");
    });
});
