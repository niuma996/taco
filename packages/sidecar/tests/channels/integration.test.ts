/**
 * IM channel P0 integration test.
 *
 * Verifies the full routing path: submit(msg) -> ConversationRouter.route()
 * -> session.create -> session.prompt. Channel push assertion deferred to emitPush wiring.
 *
 * Run: pnpm --filter @taco-ai/sidecar test tests/channels/integration.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ServerPush } from "@taco-ai/protocol";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel } from "../../src/channels/builtin/mockChannel.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";

let prevTacoHome: string | undefined;
let tmpDir: string;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(path.join(tmpdir(), "im-integration-"));
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

describe("IM channel P0 integration", () => {
    it("submit routes (channelId, peerId, chatId) to a stable sessionId via ConversationRouter", async () => {
        const transport = new InMemoryTransport();
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        await server.start(transport, []);
        // No `initialize` on purpose — an IM-only sidecar has no stdio client
        // to handshake. In-process ingress must work regardless.

        // buildChannelContext is available after start()
        const ctx = server.buildChannelContext("mock-1");

        const channel = new MockChannel();
        const handle = (await channel.start(ctx)) as MockChannelHandle;
        server.channelRegistry.register("mock-1", channel, handle);

        // First submit: should create a session and route to im://mock-1/u1/c1
        const r1 = await ctx.ingress.submit({
            channelId: "mock-1",
            peerId: "u1",
            chatId: "c1",
            platformMessageId: "msg-1",
            text: "hello",
        });
        assert.equal(r1.sessionId.length > 0, true);

        // Second submit same triple: should reuse the same sessionId
        const r2 = await ctx.ingress.submit({
            channelId: "mock-1",
            peerId: "u1",
            chatId: "c1",
            platformMessageId: "msg-2",
            text: "again",
        });
        assert.equal(r2.sessionId, r1.sessionId);

        // Different triple: should get a different sessionId
        const r3 = await ctx.ingress.submit({
            channelId: "mock-1",
            peerId: "u1",
            chatId: "c2",
            platformMessageId: "msg-3",
            text: "different chat",
        });
        assert.notEqual(r3.sessionId, r1.sessionId);

        // Push frames arrive at both stdio (InMemoryTransport) and channel handle (additive sink).
        await handle.waitForFrameCount(1, 5000);
        const channelFrames = handle.receivedFrames;
        assert.equal(channelFrames[0].workspace, "im://mock-1/u1/c1");

        const stdioFrames = transport.latestFrames();
        assert.ok(
            stdioFrames.some((f) => (f as ServerPush).workspace === "im://mock-1/u1/c1"),
            "push frame must also reach stdio",
        );

        await server.stop();
    });

    it("buildChannelContext throws when called before start()", () => {
        const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
        assert.throws(
            () => server.buildChannelContext("any-channel"),
            /conversationRouter not initialized/,
        );
    });
});
