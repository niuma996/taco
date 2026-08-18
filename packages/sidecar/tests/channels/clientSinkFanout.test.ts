/**
 * Phase 2 client-sink fan-out tests.
 *
 * Background: after the daemon-ownership refactor (PR1) the resident
 * SidecarServer owns the channel stack and IM workspaces. Its emitPush
 * runs over NullTransport — fine for outbound IM (which goes through
 * `channelRegistry.push`), but a desktop that already has an IM session
 * view open no longer sees real-time peer messages or mid-turn updates
 * because nothing reaches the connection's NDJSON transport.
 *
 * ClientSinkRegistry closes that gap: the daemon constructs one
 * registry, every connection's transport is added on start() and
 * removed on stop(), and the host's emitPush fans out im:// frames to
 * every registered sink. Tests below verify the unit semantics of the
 * registry and the end-to-end behaviour through SidecarServer.emitPush.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ServerPush } from "@taco-ai/protocol";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel, mockChannelManifest } from "../../src/channels/builtin/mockChannel.ts";
import type { ChannelConfig } from "../../src/channels/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { ClientSinkRegistry } from "../../src/server/clientSinkRegistry.ts";
import { SidecarServer } from "../../src/server/server.ts";
import type { ServerFrame, Transport } from "../../src/server/transport.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";

const mockChannelConfig: ChannelConfig = {
    channelId: "mock-1",
    manifest: mockChannelManifest,
    config: {},
};

let prevTacoHome: string | undefined;
let tmpDir: string;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(path.join(tmpdir(), "client-sink-"));
    process.env.TACO_HOME = tmpDir;
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("ClientSinkRegistry", () => {
    it("add/remove/fanout", () => {
        const r = new ClientSinkRegistry();
        assert.equal(r.size(), 0);
        const t1 = new InMemoryTransport();
        const t2 = new InMemoryTransport();
        r.add(t1);
        r.add(t2);
        assert.equal(r.size(), 2);
        r.add(t1); // idempotent
        assert.equal(r.size(), 2);

        const frame: ServerFrame = {
            kind: "push",
            method: "session.turn.started",
            workspace: "im://ch/u/c",
            session: "s",
            sessionKind: "main",
            params: {},
            seq: 1,
        } as ServerFrame;
        r.fanout(frame);
        assert.equal(t1.sent.length, 1);
        assert.equal(t2.sent.length, 1);
        assert.equal(t1.sent[0], frame);

        r.remove(t1);
        assert.equal(r.size(), 1);
        r.remove(t1); // idempotent
        r.fanout(frame);
        assert.equal(t1.sent.length, 1, "removed sink must not receive further frames");
        assert.equal(t2.sent.length, 2);
    });

    it("isolates failures — one sink rejecting does not break others", async () => {
        const r = new ClientSinkRegistry();
        const ok = new InMemoryTransport();
        const broken: Transport = {
            async open(): Promise<void> {},
            async close(): Promise<void> {},
            async send(): Promise<void> {
                throw new Error("sink offline");
            },
            onRequest(): void {},
        };
        r.add(broken);
        r.add(ok);

        // fanout must not throw — the broken sink's rejection is swallowed.
        const frame: ServerFrame = {} as ServerFrame;
        r.fanout(frame);

        // Give the rejected send() a microtask to surface. ok must still
        // have received the frame; an unhandled rejection from broken
        // would have crashed the host on Node's unhandledRejection hook.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(ok.sent.length, 1);
    });
});

/**
 * End-to-end: host emits an im:// push frame and every connected desktop's
 * transport receives it. Builds the same owner + non-owner pair as
 * daemonOwnership.test.ts, with the addition of a shared ClientSinkRegistry.
 */
async function startOwnerWithSink(): Promise<{
    owner: SidecarServer;
    nonOwner: SidecarServer;
    nonOwnerTransport: InMemoryTransport;
    sinkRegistry: ClientSinkRegistry;
}> {
    const sinkRegistry = new ClientSinkRegistry();
    const owner = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        clientSinkRegistry: sinkRegistry,
    });
    await owner.start(new InMemoryTransport(), [mockChannelConfig]);

    const channel = new MockChannel();
    const handle = (await channel.start(owner.buildChannelContext("mock-1"))) as MockChannelHandle;
    owner.channelRegistry.register("mock-1", channel, handle);

    const nonOwnerTransport = new InMemoryTransport();
    const nonOwner = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        channelRegistry: owner.channelRegistry,
        channelBindBroker: owner.channelBindBroker,
        conversationRouter: owner.conversationRouterView,
        imHost: owner,
        clientSinkRegistry: sinkRegistry,
    });
    await nonOwner.start(nonOwnerTransport, []);
    return { owner, nonOwner, nonOwnerTransport, sinkRegistry };
}

describe("client-sink fan-out (Phase 2)", () => {
    it("host im:// push reaches every connected desktop transport", async () => {
        const { owner, nonOwner, nonOwnerTransport } = await startOwnerWithSink();
        try {
            // Submit via owner — this creates the IM session and kicks off
            // session.prompt, which emits at least one push frame (the
            // channel handle receives it too — see the existing integration
            // test for the same observation).
            const ctx = owner.buildChannelContext("mock-1");
            const r = await ctx.ingress.submit({
                channelId: "mock-1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "msg-1",
                text: "hello",
            });
            const sessionId = r.sessionId;

            // Wait until the host's emitPush has delivered at least one
            // im:// frame to the non-owner's transport. Without the
            // registry, nonOwnerTransport stays empty — the regression
            // Phase 1 introduced and Phase 2 closes.
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                const frames = nonOwnerTransport.sent.filter(
                    (f) =>
                        (f as ServerPush).workspace === "im://mock-1/u1/c1" &&
                        (f as ServerPush).session === sessionId,
                );
                if (frames.length > 0) {
                    assert.ok(
                        frames.length >= 1,
                        "expected at least one im:// push frame on the desktop transport",
                    );
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.fail(
                `timed out waiting for im:// push frame; transport received ${nonOwnerTransport.sent.length} frame(s)`,
            );
        } finally {
            await nonOwner.stop();
            await owner.stop();
        }
    });

    it("removing a sink stops fan-out — disconnected desktop no longer receives", async () => {
        const { owner, nonOwner, nonOwnerTransport, sinkRegistry } = await startOwnerWithSink();
        try {
            // Drain whatever's already in flight.
            await new Promise((resolve) => setTimeout(resolve, 100));
            const before = nonOwnerTransport.sent.length;

            // Stop the non-owner → start() had registered its transport,
            // stop() must deregister it before close. Any subsequent
            // emitPush on the host must not reach the dead transport.
            await nonOwner.stop();

            // Submit another message: owner → channel handle → emitPush
            // for im://mock-1/u2/c2. The host's fanout must NOT hit the
            // deregistered nonOwnerTransport.
            const ctx = owner.buildChannelContext("mock-1");
            await ctx.ingress.submit({
                channelId: "mock-1",
                peerId: "u2",
                chatId: "c2",
                platformMessageId: "msg-after-disconnect",
                text: "still here",
            });
            // Allow fanout to run.
            await new Promise((resolve) => setTimeout(resolve, 200));

            assert.equal(
                sinkRegistry.size(),
                1,
                "after nonOwner.stop, registry holds only the host's NullTransport",
            );
            assert.equal(
                nonOwnerTransport.sent.length,
                before,
                "deregistered transport must not receive further frames",
            );
        } finally {
            await owner.stop();
        }
    });
});
