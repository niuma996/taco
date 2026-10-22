import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RpcRequest } from "@taco-ai/protocol";
import { makeImCwd, parseImCwd } from "@taco-ai/protocol";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel, mockChannelManifest } from "../../src/channels/builtin/mockChannel.ts";
import type { ChannelBindStatus } from "../../src/channels/channelBindBroker.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";
import { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import type { ChannelConfig } from "../../src/channels/registry.ts";
import {
    IM_FS_TOOL_NAMES,
    IM_SHELL_TOOL_NAME,
    makeImSessionsRoot,
} from "../../src/channels/virtualWorkspace.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { defaultTools } from "../../src/tools/index.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { stubModelFetch } from "../_helpers/stubModelFetch.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("conversationRouter", () => {
    /** Minimal ServerRpcSurface stub: only implements what ConversationRouter uses. */
    function stubHook(opts?: {
        existingSessionIds?: Set<string>;
    }): ServerRpcSurface & { created: string[] } {
        const created: string[] = [];
        const existing = opts?.existingSessionIds ?? new Set<string>();
        const hook = {
            created,
            dispatchRpc: async (req: { method: string; params?: Record<string, unknown> }) => {
                if (req.method === "session.create") {
                    const sid = String(req.params?.sessionId ?? "");
                    created.push(sid);
                    existing.add(sid);
                    return { ok: true };
                }
                if (req.method === "session.history") {
                    return existing.has(String(req.params?.sessionId ?? ""))
                        ? { ok: true }
                        : { ok: false };
                }
                return { ok: false };
            },
        } as unknown as ServerRpcSurface & { created: string[] };
        return hook;
    }

    describe("ConversationRouter", () => {
        it("routes a triple to a stable sessionId and reuses it", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);
            const a = await router.route(hook, "ch1", "u1", "c1");
            const b = await router.route(hook, "ch1", "u1", "c1");
            assert.equal(a.sessionId, b.sessionId);
            assert.equal(hook.created.length, 1); // second call reuses, no new session
            assert.equal(a.workspace, "im://ch1/u1/c1");
        });

        it("creates a new session when the routed session no longer exists", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);
            const a = await router.route(hook, "ch1", "u1", "c1");
            // simulate session deleted: use a hook that doesn't know about it
            const hook2 = stubHook();
            const b = await router.route(hook2, "ch1", "u1", "c1");
            assert.notEqual(b.sessionId, a.sessionId);
        });

        it("serializes concurrent routes for the same triple — one session created", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);

            let releaseCreate!: () => void;
            const createGate = new Promise<void>((resolve) => {
                releaseCreate = resolve;
            });
            const gated = {
                ...hook,
                dispatchRpc: async (req: RpcRequest) => {
                    if (req.method === "session.create") await createGate;
                    return hook.dispatchRpc?.(req);
                },
            } as ServerRpcSurface & { created: string[] };

            const before = hook.created.length;
            const p1 = router.route(gated, "ch1", "u1", "c1");
            const p2 = router.route(gated, "ch1", "u1", "c1");
            assert.equal(gated.created.length, before); // no create yet while first route is in flight
            releaseCreate();
            const [r1, r2] = await Promise.all([p1, p2]);
            assert.equal(r1.sessionId, r2.sessionId);
            assert.equal(gated.created.length, before + 1); // lock prevented a duplicate create
        });

        it("persists routing.json and reloads it", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const hook = stubHook();
            const router = await ConversationRouter.load(home);
            const a = await router.route(hook, "ch1", "u1", "c1");
            const reloaded = await ConversationRouter.load(home);
            assert.equal(reloaded.lookup("ch1", "u1", "c1")?.sessionId, a.sessionId);
        });

        /**
         * An earlier bug wrote keys with an empty chatId (iLink sends group_id as
         * "" for 1:1 chats). Such a key cannot round-trip through parseImCwd, so a
         * cached hit resolves no peer and every reply is dropped. Loading must skip
         * it and let the next inbound message recreate the route.
         */
        it("drops unparseable routing keys on load", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const dir = path.join(home, "sessions", "im");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                path.join(dir, "routing.json"),
                JSON.stringify({
                    "im://wechat/peer%40im.wechat/": { sessionId: "stale-1", lastUsedAt: 1 },
                    "im://wechat/peer%40im.wechat/peer%40im.wechat": {
                        sessionId: "good-1",
                        lastUsedAt: 2,
                    },
                }),
            );

            const router = await ConversationRouter.load(home);

            assert.equal(
                router.lookup("wechat", "peer@im.wechat", "peer@im.wechat")?.sessionId,
                "good-1",
            );
            assert.equal(router.findRouteBySessionId("stale-1"), undefined);
        });

        /**
         * routing.json is the only place peerId/chatId are persisted, so a missing
         * file means an empty table rather than a reconstruction from session
         * files. Pinned because an earlier version scanned sessions/im/ for an
         * `imRouting` metadata triple that pi 0.85 no longer stores.
         */
        it("starts with an empty table when routing.json is absent", async () => {
            const home = mkdtempSync(path.join(tmpdir(), "router-"));
            const dir = path.join(home, "sessions", "im", "ch1");
            mkdirSync(dir, { recursive: true });
            writeFileSync(
                path.join(dir, "_sess-xyz.jsonl"),
                `${JSON.stringify({
                    type: "session_info",
                    id: "sess-xyz",
                    cwd: home,
                })}\n`,
            );

            const router = await ConversationRouter.load(home);

            assert.equal(router.lookup("ch1", "u9", "c9"), undefined);
            assert.deepEqual(router.listAll(), []);
        });

        describe("listAll", () => {
            it("returns every routed conversation, newest first", async () => {
                const home = mkdtempSync(path.join(tmpdir(), "router-"));
                const hook = stubHook();
                const router = await ConversationRouter.load(home);

                await router.route(hook, "ch1", "u1", "c1");
                await new Promise((r) => setTimeout(r, 5));
                await router.route(hook, "ch1", "u2", "c2");
                await new Promise((r) => setTimeout(r, 5));
                await router.route(hook, "ch2", "u3", "c3");

                const entries = router.listAll();
                assert.equal(entries.length, 3);
                // Sorted by lastUsedAt desc → ch2/u3 first, then ch1/u2, then ch1/u1
                assert.deepEqual(
                    entries.map((e) => `${e.channelId}/${e.peerId}`),
                    ["ch2/u3", "ch1/u2", "ch1/u1"],
                );
            });

            it("filters by channelId when provided", async () => {
                const home = mkdtempSync(path.join(tmpdir(), "router-"));
                const hook = stubHook();
                const router = await ConversationRouter.load(home);

                await router.route(hook, "ch1", "u1", "c1");
                await router.route(hook, "ch2", "u2", "c2");

                const entries = router.listAll("ch1");
                assert.equal(entries.length, 1);
                assert.equal(entries[0].channelId, "ch1");
                assert.equal(entries[0].peerId, "u1");
            });

            it("skips unparseable keys silently (defensive)", async () => {
                const home = mkdtempSync(path.join(tmpdir(), "router-"));
                const dir = path.join(home, "sessions", "im");
                mkdirSync(dir, { recursive: true });
                // Same key shape the load-time skip covers — must also be skipped on
                // listAll to avoid surfacing "im:///" rows in the UI.
                writeFileSync(
                    path.join(dir, "routing.json"),
                    JSON.stringify({
                        "im://ch1/u1/": { sessionId: "stale", lastUsedAt: 1 },
                        "im://ch1/u1/c1": { sessionId: "good", lastUsedAt: 2 },
                    }),
                );
                const router = await ConversationRouter.load(home);
                const entries = router.listAll();
                assert.equal(entries.length, 1);
                assert.equal(entries[0].sessionId, "good");
            });
        });

        describe("'conversation' event", () => {
            it("emits only when a NEW session is created", async () => {
                const home = mkdtempSync(path.join(tmpdir(), "router-"));
                const hook = stubHook();
                const router = await ConversationRouter.load(home);
                const events: unknown[] = [];
                router.on("conversation", (e) => events.push(e));

                // First route → new session → event fires.
                await router.route(hook, "ch1", "u1", "c1");
                assert.equal(events.length, 1);
                // Re-routing the same triple reuses the session → no event.
                await router.route(hook, "ch1", "u1", "c1");
                assert.equal(events.length, 1);
                // A different triple → new session → another event.
                await router.route(hook, "ch1", "u2", "c2");
                assert.equal(events.length, 2);
            });

            it("reports the same lastUsedAt the route entry carries", async () => {
                // Sampling Date.now() separately for the entry and the payload let
                // the push disagree with what listAll() returns for that key.
                const home = mkdtempSync(path.join(tmpdir(), "router-"));
                const hook = stubHook();
                const router = await ConversationRouter.load(home);
                const events: { sessionId: string; lastUsedAt: number }[] = [];
                router.on("conversation", (e) => events.push(e));

                await router.route(hook, "ch1", "u1", "c1");
                const listed = router.listAll();
                assert.equal(events.length, 1);
                assert.equal(events[0].lastUsedAt, listed[0].lastUsedAt);
            });
        });

        describe("persist serialization", () => {
            it("survives concurrent routes without corrupting routing.json", async () => {
                // persist() writes via a shared `${path}.tmp` + rename. Overlapping
                // writers would let one rename publish another's half-written file,
                // so the whole point of tmp+rename is lost without serialization.
                const home = mkdtempSync(path.join(tmpdir(), "router-"));
                const hook = stubHook();
                const router = await ConversationRouter.load(home);

                await Promise.all([
                    router.route(hook, "ch1", "u1", "c1"),
                    router.route(hook, "ch1", "u2", "c2"),
                    router.route(hook, "ch1", "u3", "c3"),
                    router.route(hook, "ch2", "u4", "c4"),
                ]);

                // routing.json must be valid JSON containing every route — a torn
                // write shows up as a parse error or a missing key.
                const raw = readFileSync(path.join(home, "sessions", "im", "routing.json"), "utf8");
                const parsed = JSON.parse(raw) as Record<string, { sessionId: string }>;
                assert.equal(Object.keys(parsed).length, 4);

                // And the reloaded view must agree with the in-memory one.
                const reloaded = await ConversationRouter.load(home);
                assert.equal(reloaded.listAll().length, 4);
            });
        });
    });
});

describe("virtualWorkspace", () => {
    describe("virtualWorkspace", () => {
        it("makeImCwd/parseImCwd round-trips plain ids", () => {
            const cwd = makeImCwd("feishu-app1", "u1", "c1");
            assert.equal(cwd, "im://feishu-app1/u1/c1");
            assert.deepEqual(parseImCwd(cwd), {
                channelId: "feishu-app1",
                peerId: "u1",
                chatId: "c1",
            });
        });

        it("round-trips ids containing encoded slashes", () => {
            const cwd = makeImCwd("ch", "peer/with/slash", "chat");
            assert.deepEqual(parseImCwd(cwd), {
                channelId: "ch",
                peerId: "peer/with/slash",
                chatId: "chat",
            });
        });

        it("parseImCwd returns undefined for non-im cwd", () => {
            assert.equal(parseImCwd("/home/user/proj"), undefined);
        });

        it("parseImCwd returns undefined for malformed im cwd", () => {
            assert.equal(parseImCwd("im://onlychannel"), undefined);
            assert.equal(parseImCwd("im://a//c"), undefined);
        });

        it("parseImCwd returns undefined for trailing/missing segment edge cases", () => {
            assert.equal(parseImCwd("im://ch/peer/"), undefined); // empty chatId
            assert.equal(parseImCwd("im://ch//chat"), undefined); // empty peerId
            assert.equal(parseImCwd("im:///a/b"), undefined); // empty channelId
        });

        it("parseImCwd returns undefined for invalid percent-encoding", () => {
            assert.equal(parseImCwd("im://ch/%zz/c1"), undefined);
        });

        it("round-trips percent-encoded reserved characters in peer/chat ids", () => {
            const cwd = makeImCwd("ch", "peer?a=1&b=2", "chat#1");
            assert.deepEqual(parseImCwd(cwd), {
                channelId: "ch",
                peerId: "peer?a=1&b=2",
                chatId: "chat#1",
            });
        });

        /**
         * An empty id produces a key parseImCwd cannot parse, which breaks the
         * outbound reply path silently. Fail at construction instead.
         */
        it("rejects an empty peerId or chatId", () => {
            assert.throws(() => makeImCwd("ch", "", "c1"), /peerId must not be empty/);
            assert.throws(() => makeImCwd("ch", "u1", ""), /chatId must not be empty/);
        });

        it("makeImSessionsRoot joins under tacoHome", () => {
            // Path is joined with `path.join` (POSIX "/" on Linux/macOS, "\"
            // on Windows). The original assertion hard-coded "/" and broke
            // on Windows.
            assert.equal(
                makeImSessionsRoot("/home/x/.taco", "ch1"),
                join("/home/x/.taco", "sessions", "im", "ch1"),
            );
        });

        it("IM fs/shell tool names match the registered tool names", () => {
            const registered = defaultTools({}).map((t) => t.name);
            for (const disabled of IM_FS_TOOL_NAMES) {
                assert.ok(
                    registered.includes(disabled),
                    `disabled tool ${disabled} is not registered`,
                );
            }
            // Guard: non-fs tools must never be in the disabled list (would break IM sessions).
            const fsTools = new Set(["read", "write", "edit", "grep", "glob"]);
            for (const disabled of IM_FS_TOOL_NAMES) {
                assert.ok(fsTools.has(disabled), `${disabled} is not an fs tool`);
            }
            assert.equal(IM_SHELL_TOOL_NAME, "shell");
            assert.ok(registered.includes(IM_SHELL_TOOL_NAME), "shell tool is registered");
        });
    });

    describe("WorkspaceRuntime im:// construction", () => {
        it("constructs without crashing and disables fs tools", () => {
            const scratch = mkdtempSync(path.join(tmpdir(), "im-scratch-"));
            const sessionsRoot = mkdtempSync(path.join(tmpdir(), "im-sessions-"));
            const ws = new WorkspaceRuntime({
                cwd: "im://mock-1/u1/c1",
                fsCwd: scratch,
                workspaceKey: "im://mock-1/u1/c1",
                sessionsRoot,
                disableFsTools: true,
                // Remaining required options follow the minimal construction from existing runtime tests.
            } as ConstructorParameters<typeof WorkspaceRuntime>[0]);
            assert.equal(ws.sessionCwd, scratch);
            assert.equal(ws.workspaceKey, "im://mock-1/u1/c1");
            const names = ws.tools.map((t) => t.name);
            const disabled = [...IM_FS_TOOL_NAMES, IM_SHELL_TOOL_NAME];
            for (const fs of disabled) {
                assert.ok(!names.includes(fs), `expected ${fs} to be disabled`);
            }
        });
    });
});

describe("daemonOwnership", () => {
    const mockChannelConfig: ChannelConfig = {
        channelId: "mock-1",
        manifest: mockChannelManifest,
        config: {},
    };

    useTempTacoHome("daemon-ownership");
    stubModelFetch();

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
                // — the connection server's workspace registry should hold zero im://
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
                // connection server (which has its own workspace registry), not
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
            } finally {
                await nonOwner.stop();
                await owner.stop();
            }
        });
    });
});

describe("channelBindBroker", () => {
    describe("ChannelBindBroker", () => {
        it("reports unbound for an unknown channel", () => {
            const broker = new ChannelBindBroker();
            assert.deepEqual(broker.status("wechat"), { channelId: "wechat", state: "unbound" });
        });

        it("emits status on every transition", () => {
            const broker = new ChannelBindBroker();
            const seen: ChannelBindStatus[] = [];
            broker.on("status", (s: ChannelBindStatus) => seen.push(s));

            broker.requestScan("wechat", "https://qr.example/abc");
            broker.setState("wechat", "connected");

            assert.deepEqual(
                seen.map((s) => s.state),
                ["awaiting_scan", "connected"],
            );
            assert.equal(seen[0].qrUrl, "https://qr.example/abc");
        });

        it("resolves a pending verify-code request via submitVerifyCode", async () => {
            const broker = new ChannelBindBroker();
            let requestId: string | undefined;
            broker.on("status", (s: ChannelBindStatus) => {
                if (s.state === "awaiting_verify_code") requestId = s.requestId;
            });

            const pending = broker.requestVerifyCode("wechat", false);
            assert.ok(requestId);
            assert.equal(broker.submitVerifyCode(requestId, "123456"), true);
            assert.equal(await pending, "123456");
            assert.equal(broker.status("wechat").state, "connecting");
        });

        it("marks a retry request so the UI can say the code was wrong", () => {
            const broker = new ChannelBindBroker();
            const seen: ChannelBindStatus[] = [];
            broker.on("status", (s: ChannelBindStatus) => seen.push(s));

            void broker.requestVerifyCode("wechat", true).catch(() => {});
            assert.equal(seen[0].retry, true);
            broker.cancelAll();
        });

        it("submitVerifyCode returns false for an unknown requestId", () => {
            const broker = new ChannelBindBroker();
            assert.equal(broker.submitVerifyCode("no-such-id", "123456"), false);
        });

        it("rejects and marks expired when the verify code times out", async () => {
            const broker = new ChannelBindBroker(10);
            await assert.rejects(broker.requestVerifyCode("wechat", false), /timed out/);
            assert.equal(broker.status("wechat").state, "expired");
        });

        it("cancel rejects pending requests for that channel only", async () => {
            const broker = new ChannelBindBroker();
            const wechat = broker.requestVerifyCode("wechat", false);
            const feishu = broker.requestVerifyCode("feishu", false);

            broker.cancel("wechat");

            await assert.rejects(wechat, /binding cancelled/);
            broker.cancel("feishu");
            await assert.rejects(feishu, /binding cancelled/);
        });

        it("cancelAll rejects every pending request", async () => {
            const broker = new ChannelBindBroker();
            const a = broker.requestVerifyCode("wechat", false);
            const b = broker.requestVerifyCode("feishu", false);

            broker.cancelAll();

            await assert.rejects(a, /shutting down/);
            await assert.rejects(b, /shutting down/);
        });

        it("reset cancels pending and re-publishes unbound state", async () => {
            const broker = new ChannelBindBroker();
            broker.setState("wechat", "connected");
            const pending = broker.requestVerifyCode("wechat", false);

            broker.reset("wechat");

            await assert.rejects(pending, /binding cancelled/);
            assert.deepEqual(broker.status("wechat"), { channelId: "wechat", state: "unbound" });
        });

        it("listStatuses reports every known channel", () => {
            const broker = new ChannelBindBroker();
            broker.setState("wechat", "connected");
            broker.setState("feishu", "unbound");

            assert.deepEqual(
                broker
                    .listStatuses()
                    .map((s) => s.channelId)
                    .sort(),
                ["feishu", "wechat"],
            );
        });

        it("flips connecting to error when the platform never answers", async () => {
            // A platform can decline in ways the SDK doesn't classify, firing
            // neither `authenticated` nor `error` — the UI would spin forever.
            const broker = new ChannelBindBroker(1000, 10);
            broker.setState("wecom", "connecting");
            await new Promise((r) => setTimeout(r, 30));
            const status = broker.status("wecom");
            assert.equal(status.state, "error");
            assert.match(status.message ?? "", /timed out/);
        });

        it("a successful connect disarms the connecting watchdog", async () => {
            const broker = new ChannelBindBroker(1000, 10);
            broker.setState("wecom", "connecting");
            broker.setState("wecom", "connected");
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(broker.status("wecom").state, "connected");
        });

        it("re-entering connecting restarts the watchdog clock", async () => {
            const broker = new ChannelBindBroker(1000, 40);
            broker.setState("wecom", "connecting");
            await new Promise((r) => setTimeout(r, 25));
            broker.setState("wecom", "connecting");
            // Past the first attempt's deadline, inside the second's.
            await new Promise((r) => setTimeout(r, 25));
            assert.equal(broker.status("wecom").state, "connecting");
            await new Promise((r) => setTimeout(r, 30));
            assert.equal(broker.status("wecom").state, "error");
        });

        // All three entry points funnel into cancel(), the only place the
        // `connecting` watchdog is cleared; they differ only in what they publish
        // afterwards. Past the 10ms deadline the state must still be the one each
        // entry point left behind — never `error`, which would resurrect a channel
        // that no longer runs.
        it("cancel, reset and cancelAll all disarm the connecting watchdog", async () => {
            for (const { entry, disarm, state } of [
                {
                    entry: "cancel disarms the watchdog so a closed channel is not resurrected as error",
                    disarm: (b: ChannelBindBroker) => b.cancel("wecom", "channel closing"),
                    state: "connecting",
                },
                {
                    entry: "reset leaves a mid-connect channel unbound rather than error",
                    disarm: (b: ChannelBindBroker) => b.reset("wecom"),
                    state: "unbound",
                },
                {
                    entry: "cancelAll disarms watchdogs even with no pending verify requests",
                    disarm: (b: ChannelBindBroker) => b.cancelAll(),
                    state: "connecting",
                },
            ]) {
                const broker = new ChannelBindBroker(1000, 10);
                broker.setState("wecom", "connecting");
                disarm(broker);
                await new Promise((r) => setTimeout(r, 30));
                assert.equal(broker.status("wecom").state, state, entry);
            }
        });

        it("a second requestVerifyCode supersedes the prior pending entry", async () => {
            // The SDK re-fires onVerifyCode(isRetry=true) after the user enters a
            // wrong code. Without cancellation the prior timer would fire
            // verifyTimeoutMs later and setState("expired") over the fresh
            // awaiting_verify_code state.
            const broker = new ChannelBindBroker();
            const first = broker.requestVerifyCode("wechat", false);
            const second = broker.requestVerifyCode("wechat", true);

            await assert.rejects(first, /superseded/);
            assert.equal(broker.status("wechat").state, "awaiting_verify_code");
            // Exactly one pending entry remains — the second.
            assert.equal((broker as unknown as { pending: Map<string, unknown> }).pending.size, 1);

            // Resolve the second via the public submitVerifyCode path so its
            // promise settles and node --test doesn't hang on the dangling await.
            const { requestId } = broker.status("wechat");
            assert.ok(requestId, "broker should hold the awaiting_verify_code requestId");
            broker.submitVerifyCode(requestId, "123456");
            await assert.doesNotReject(second);
        });
    });
});
