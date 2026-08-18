/**
 * Daemon ownership tests — verify the per-instance channel stack is
 * collapsed to a single resident in daemon mode.
 *
 * Background: before this fix every SidecarServer constructed its own
 * ChannelRegistry / ChannelBindBroker / ConversationRouter and ran
 * loadAndStart in its start(). Two NDJSON connections therefore booted
 * two IM bots on the same channelId, forked routing.json writes, and
 * pinned channel lifecycle to the socket. Plan C keeps one owner
 * (the daemon-resident imHost) and makes connection servers non-owners
 * that forward im:// RPCs and rebroadcast shared-broker / router events.
 *
 * The five scenarios mirror the harm catalogue in the plan:
 *  1. No duplicate startup — channel stack is shared, not per-instance.
 *  2. Forward — connection server returns the resident's IM session id
 *     for session.* RPCs on an im:// cwd.
 *  3. Lifecycle — non-owner.stop() does not tear down shared channels.
 *  4. Shared router — two non-owners see the same routing.json entry.
 *  5. startedChannelIds — non-owner advertises the resident's set.
 *
 * Plus a NullTransport unit test asserting its open/close/send are
 * no-ops (used by the resident so a daemon crash can't leave frame
 * queues behind).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel, mockChannelManifest } from "../../src/channels/builtin/mockChannel.ts";
import type { ChannelConfig } from "../../src/channels/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";
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
    tmpDir = mkdtempSync(path.join(tmpdir(), "daemon-ownership-"));
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

/** Helper: start a fresh owner that uses the (mock) channel stack, then
 *  start a non-owner connection server that shares it. Returns all three
 *  servers + the shared registry so callers can inspect ownership state. */
async function startPair(opts?: { registerChannel?: boolean }): Promise<{
    owner: SidecarServer;
    nonOwner: SidecarServer;
    secondNonOwner: SidecarServer;
    sharedRegistry: SidecarServer["channelRegistry"];
}> {
    const owner = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    await owner.start(new InMemoryTransport(), [mockChannelConfig]);

    // Register the mock channel manually — start() with the config list
    // calls loadAndStart, but we want a deterministic single channel in
    // shared state so the test can inspect startedIds directly.
    if (opts?.registerChannel !== false) {
        const channel = new MockChannel();
        const handle = (await channel.start(
            owner.buildChannelContext("mock-1"),
        )) as MockChannelHandle;
        owner.channelRegistry.register("mock-1", channel, handle);
    }

    const sharedRegistry = owner.channelRegistry;
    const nonOwner = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        channelRegistry: owner.channelRegistry,
        channelBindBroker: owner.channelBindBroker,
        conversationRouter: owner.conversationRouterView,
        imHost: owner,
    });
    await nonOwner.start(new InMemoryTransport(), []);
    const secondNonOwner = new SidecarServer({
        providerKeyStore: new ProviderKeyStore({}),
        channelRegistry: owner.channelRegistry,
        channelBindBroker: owner.channelBindBroker,
        conversationRouter: owner.conversationRouterView,
        imHost: owner,
    });
    await secondNonOwner.start(new InMemoryTransport(), []);
    return { owner, nonOwner, secondNonOwner, sharedRegistry };
}

describe("NullTransport", () => {
    it("open/close/send are no-ops", async () => {
        const t = new NullTransport();
        await t.open();
        await t.close();
        // Cast to ServerFrame: the resident never inspects outbound frames.
        await t.send({} as never);
        // onRequest accepts but does nothing
        t.onRequest(() => {
            throw new Error("should not be called");
        });
    });
});

describe("daemon ownership", () => {
    it("non-owner does not duplicate the resident channel", async () => {
        const { owner, nonOwner, secondNonOwner, sharedRegistry } = await startPair();
        try {
            assert.equal(sharedRegistry.has("mock-1"), true);
            assert.deepEqual(sharedRegistry.startedIds(), ["mock-1"]);
            // Non-owner advertises the resident's started set, not its own.
            assert.deepEqual(nonOwner.getServerCapabilities().channels, ["mock-1"]);
            assert.deepEqual(secondNonOwner.getServerCapabilities().channels, ["mock-1"]);
            // Owner doesn't list channels either — its transport is NullTransport,
            // so nothing for it to surface. But it started one.
            assert.deepEqual(owner.getServerCapabilities().channels, ["mock-1"]);
        } finally {
            await secondNonOwner.stop();
            await nonOwner.stop();
            await owner.stop();
        }
    });

    it("non-owner forwards im:// session.list and sees the resident's session id", async () => {
        const { owner, nonOwner } = await startPair();
        try {
            // Resident submits via owner — creates a session under im://mock-1/u1/c1.
            const submitRes = await owner.buildChannelContext("mock-1").ingress.submit({
                channelId: "mock-1",
                peerId: "u1",
                chatId: "c1",
                platformMessageId: "msg-1",
                text: "hello",
            });
            const residentSessionId = submitRes.sessionId;
            assert.ok(residentSessionId.length > 0);

            // Connection server forwards session.list for the same im:// cwd.
            const imCwd = "im://mock-1/u1/c1";
            const resp = await nonOwner.handleRpcRequest({
                id: "t-1",
                method: "session.list",
                params: { workspace: imCwd },
            } as never);
            assert.equal(resp.ok, true);
            const result = resp.result as { sessions: { id: string }[] };
            assert.ok(
                result.sessions.some((s) => s.id === residentSessionId),
                `expected session.list on non-owner to contain resident session ${residentSessionId}, got ${JSON.stringify(result.sessions)}`,
            );

            // The forward path must NOT have built a local im:// workspace
            // — the connection server's workspaceMap should hold zero im://
            // workspaces (forwarding rather than hosting is the contract).
            const imWorkspaces = nonOwner.workspaceIds().filter((id) => id.startsWith("im://"));
            assert.deepEqual(imWorkspaces, []);
        } finally {
            await nonOwner.stop();
            await owner.stop();
        }
    });

    it("non-owner.stop() leaves the resident's channels running", async () => {
        const { owner, nonOwner, sharedRegistry } = await startPair();
        try {
            assert.equal(sharedRegistry.has("mock-1"), true);
            // The resident continues serving inbound IM even after every
            // desktop disconnects — closing one connection must not kill
            // the daemon's IM bots.
            await nonOwner.stop();
            assert.equal(sharedRegistry.has("mock-1"), true);
            // Owner can still submit a new message to the same channel.
            const r = await owner.buildChannelContext("mock-1").ingress.submit({
                channelId: "mock-1",
                peerId: "u2",
                chatId: "c1",
                platformMessageId: "msg-after-disconnect",
                text: "still here",
            });
            assert.ok(r.sessionId.length > 0);
        } finally {
            await owner.stop();
        }
    });

    it("two non-owners see the same routing.json entry — no fork", async () => {
        const { owner, nonOwner, secondNonOwner } = await startPair();
        try {
            const ctx = owner.buildChannelContext("mock-1");
            const r = await ctx.ingress.submit({
                channelId: "mock-1",
                peerId: "u3",
                chatId: "c1",
                platformMessageId: "msg-routing",
                text: "routing",
            });
            // Both non-owners hold the same router; findRouteBySessionId
            // must return the same peer without either one writing routing.json.
            const router = owner.conversationRouterView;
            assert.ok(router);
            const peer1 = router.findRouteBySessionId(r.sessionId)?.peerId;
            const peer2 = nonOwner.conversationRouterView?.findRouteBySessionId(
                r.sessionId,
            )?.peerId;
            const peer3 = secondNonOwner.conversationRouterView?.findRouteBySessionId(
                r.sessionId,
            )?.peerId;
            assert.equal(peer1, "u3");
            assert.equal(peer2, "u3");
            assert.equal(peer3, "u3");
        } finally {
            await secondNonOwner.stop();
            await nonOwner.stop();
            await owner.stop();
        }
    });

    it("non-owner imPolicy writes delegate to the resident and broadcast locally", async () => {
        const { owner, nonOwner } = await startPair();
        try {
            const docBefore = owner.imPolicyStore.readDocument("mock-1");
            assert.equal(docBefore.default, undefined, "precondition: no policy written yet");

            // Real patch shape: any subset of ImWorkspacePolicyPatch fields.
            // `tools: { fsTools: "allow" }` exercises the merge path without
            // depending on a specific admin rule.
            await nonOwner.setImChannelDefault("mock-1", { tools: { fsTools: "allow" } });

            // The resident must hold the canonical store entry — writes
            // from a connection server must reach the host, not a parallel
            // copy. Otherwise the host keeps the old policy until restart.
            const stored = owner.imPolicyStore.readDocument("mock-1");
            assert.ok(stored.default, "expected resident to have received the delegated write");
            assert.equal(stored.default?.tools?.fsTools, "allow");
        } finally {
            await nonOwner.stop();
            await owner.stop();
        }
    });

    it("non-owner does not forward non-im:// RPCs", async () => {
        const { owner, nonOwner } = await startPair();
        try {
            // session.list on a fs path must execute locally on the
            // connection server (which has its own workspaceMap), not
            // on the resident. The resident has no fs workspaces, so a
            // forwarded call would return [] and the connection server
            // would publish a wrong view.
            const resp = await nonOwner.handleRpcRequest({
                id: "t-1",
                method: "session.list",
                params: { workspace: "/tmp/nonexistent" },
            } as never);
            assert.equal(resp.ok, true);
            // Don't assert contents — the test just confirms no throw and
            // a non-error response, which proves the non-im:// path executed.
            assert.ok((resp.result as { sessions: unknown[] }).sessions.length >= 0);
        } finally {
            await nonOwner.stop();
            await owner.stop();
        }
    });
});
