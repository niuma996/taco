import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { RpcRequest, RpcResponse, ServerPush } from "@taco-ai/protocol";
import { asSessionId, asWorkspaceId, PushMethods } from "@taco-ai/protocol";
import {
    chunkText,
    extractReplyText,
    interruptNoticeText,
} from "../../src/channels/builtin/channelReply.ts";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel, mockChannelManifest } from "../../src/channels/builtin/mockChannel.ts";
import {
    CREDENTIALS_KEY,
    channelStatePath,
    FileChannelConfigStore,
    hasStoredCredentials,
} from "../../src/channels/channelConfigStore.ts";
import type { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import { DefaultChannelContext } from "../../src/channels/ingress.ts";
import type { ChannelConfig } from "../../src/channels/registry.ts";
import { ChannelRegistry, validateChannelInstanceId } from "../../src/channels/registry.ts";
import type {
    Channel,
    ChannelConfigStore,
    ChannelContext,
    ChannelHandle,
    ChannelManifest,
    Logger,
} from "../../src/channels/types.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import type { ServerRpcSurface } from "../../src/runtime/serverRpcSurface.ts";
import { ClientSinkRegistry } from "../../src/server/clientSinkRegistry.ts";
import { SidecarServer } from "../../src/server/server.ts";
import type { ServerFrame, Transport } from "../../src/server/transport.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { stubModelFetch } from "../_helpers/stubModelFetch.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("channelConfigStore", () => {
    let home: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), "taco-channel-store-"));
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    describe("FileChannelConfigStore", () => {
        it("round-trips values through disk", async () => {
            const store = new FileChannelConfigStore("wechat", {}, home);
            await store.set("token", "t-123");

            const reopened = new FileChannelConfigStore("wechat", {}, home);
            assert.equal(reopened.get<string>("token"), "t-123");
        });

        it("writes the state file with 0o600", async () => {
            // POSIX mode bits are a no-op on Windows (see fsPermissions.ts),
            // so the assertion is meaningless there. The production code
            // emits a one-shot warning to make this discoverable, but the
            // ACL a per-user %LOCALAPPDATA% install gives the file is
            // enough to keep sibling accounts off it.
            if (process.platform === "win32") return;

            const store = new FileChannelConfigStore("wechat", {}, home);
            await store.set("token", "t-123");

            const mode = fs.statSync(channelStatePath("wechat", home)).mode & 0o777;
            assert.equal(mode, 0o600);
        });

        it("seeds from the taco.json config block", () => {
            const store = new FileChannelConfigStore("wechat", { appId: "a1" }, home);
            assert.equal(store.get<string>("appId"), "a1");
        });

        it("persisted state wins over the seed on key collision", async () => {
            const first = new FileChannelConfigStore("wechat", { token: "from-config" }, home);
            await first.set("token", "from-runtime");

            const reopened = new FileChannelConfigStore("wechat", { token: "from-config" }, home);
            assert.equal(reopened.get<string>("token"), "from-runtime");
        });

        it("concurrent writes do not lose values", async () => {
            const store = new FileChannelConfigStore("wechat", {}, home);
            await Promise.all([store.set("a", 1), store.set("b", 2), store.set("c", 3)]);

            const reopened = new FileChannelConfigStore("wechat", {}, home);
            assert.equal(reopened.get<number>("a"), 1);
            assert.equal(reopened.get<number>("b"), 2);
            assert.equal(reopened.get<number>("c"), 3);
        });

        it("namespaces state per channelId", async () => {
            await new FileChannelConfigStore("wechat", {}, home).set("token", "wx");
            await new FileChannelConfigStore("feishu", {}, home).set("token", "fs");

            assert.equal(new FileChannelConfigStore("wechat", {}, home).get<string>("token"), "wx");
            assert.equal(new FileChannelConfigStore("feishu", {}, home).get<string>("token"), "fs");
        });

        it("clear removes persisted state and falls back to the seed", async () => {
            const store = new FileChannelConfigStore("wechat", { appId: "a1" }, home);
            await store.set("token", "t-123");
            await store.clear();

            assert.equal(store.get<string>("token"), undefined);
            assert.equal(store.get<string>("appId"), "a1");
            assert.equal(fs.existsSync(channelStatePath("wechat", home)), false);
        });

        it("treats a corrupt state file as empty rather than throwing", () => {
            const file = channelStatePath("wechat", home);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, "{ not json");

            const store = new FileChannelConfigStore("wechat", { appId: "a1" }, home);
            assert.equal(store.get<string>("token"), undefined);
            assert.equal(store.get<string>("appId"), "a1");
        });

        it("rejects an invalid channelId", () => {
            assert.throws(
                () => new FileChannelConfigStore("Bad/ID", {}, home),
                /invalid channelId/,
            );
        });
    });

    describe("hasStoredCredentials", () => {
        it("is false when the channel has no state file", () => {
            assert.equal(hasStoredCredentials("wechat", home), false);
        });

        it("is false when the state file exists without a credentials key", async () => {
            // A seed-only config block (no bind yet) must not read as configured.
            await new FileChannelConfigStore("wechat", {}, home).set("cursor", "c-1");
            assert.equal(hasStoredCredentials("wechat", home), false);
        });

        it("is true once credentials are stored — the contract is disk state", async () => {
            // This is the whole point of probing disk instead of deriving from the
            // bind state: an errored/expired binding still has credentials, so the
            // UI must offer Rebind rather than Bind.
            await new FileChannelConfigStore("wechat", {}, home).set(CREDENTIALS_KEY, {
                uin: "u1",
            });
            assert.equal(hasStoredCredentials("wechat", home), true);
        });

        it("is false after clear (unbind)", async () => {
            const store = new FileChannelConfigStore("wechat", {}, home);
            await store.set(CREDENTIALS_KEY, { uin: "u1" });
            await store.clear();
            assert.equal(hasStoredCredentials("wechat", home), false);
        });

        it("is false for a corrupt state file", () => {
            const file = channelStatePath("wechat", home);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, "{ not json");
            assert.equal(hasStoredCredentials("wechat", home), false);
        });
    });
});

describe("registry", () => {
    function frame(method: string): ServerPush {
        return { method, workspace: "w", session: "s", params: {} } as unknown as ServerPush;
    }

    const mockManifest: ChannelManifest = {
        name: "mock",
        version: "0.1.0",
        capabilities: { maxMessageLength: 4096 },
    };

    function failingResolver(): Channel {
        throw new Error("unknown channel manifest: nope");
    }

    describe("ChannelRegistry", () => {
        it("loadAndStart reports failed channels without throwing", async () => {
            const registry = new ChannelRegistry();
            const result = await registry.loadAndStart(
                [{ channelId: "bad-1", manifest: mockManifest, config: {} }],
                failingResolver,
                () => {
                    throw new Error("ctx");
                },
            );
            assert.equal(result.failed.length, 1);
            assert.equal(result.failed[0].channelId, "bad-1");
            assert.match(result.failed[0].error, /unknown channel manifest/);
        });

        it("loadAndStart resolves the Channel via the factory from manifest.name", async () => {
            const registry = new ChannelRegistry();
            const result = await registry.loadAndStart(
                [{ channelId: "mock-1", manifest: mockManifest, config: {} }],
                () => new MockChannel(),
                () => ({}) as ChannelContext,
            );
            assert.deepEqual(result.started, ["mock-1"]);
            assert.deepEqual(result.failed, []);
            assert.ok(registry.has("mock-1"));
        });

        it("loadAndStart hands each channel its own taco.json config block", async () => {
            const registry = new ChannelRegistry();
            const seen: { channelId: string; config: Record<string, unknown> }[] = [];
            await registry.loadAndStart(
                [{ channelId: "mock-1", manifest: mockManifest, config: { appId: "a1" } }],
                () => new MockChannel(),
                (channelId, config) => {
                    seen.push({ channelId, config });
                    return {} as ChannelContext;
                },
            );
            assert.deepEqual(seen, [{ channelId: "mock-1", config: { appId: "a1" } }]);
        });

        it("push delivers frames to the registered channel in order", async () => {
            const registry = new ChannelRegistry();
            const channel = new MockChannel();
            const handle = (await channel.start({} as ChannelContext)) as MockChannelHandle;
            registry.register("mock-1", channel, handle);
            registry.push("mock-1", frame("a"));
            registry.push("mock-1", frame("b"));
            await handle.waitForFrameCount(2);
            const received = handle.receivedFrames;
            assert.deepEqual(
                received.map((f) => f.method),
                ["a", "b"],
            );
        });

        it("stop drains pending pushes before closing the handle", async () => {
            const registry = new ChannelRegistry();
            const channel = new MockChannel();
            let closed = false;
            let releasePush!: () => void;
            const gate = new Promise<void>((resolve) => {
                releasePush = resolve;
            });
            const handle: ChannelHandle = {
                push: async () => {
                    await gate;
                },
                close: async () => {
                    closed = true;
                },
            };
            registry.register("mock-1", channel, handle);
            registry.push("mock-1", frame("a"));
            const stopping = registry.stop("mock-1");
            // stop() is in-flight; close must not have run while the push is pending.
            assert.equal(closed, false);
            releasePush();
            await stopping;
            assert.equal(closed, true);
            assert.equal(registry.has("mock-1"), false);
        });

        it("trackWorkspace associates im workspaces with a channel", () => {
            const registry = new ChannelRegistry();
            registry.trackWorkspace("mock-1", "im://mock-1/u1/c1");
            // Internal association asserted indirectly via stop cleanup; P0 only verifies no throw
        });

        it("push silently ignores non-existent channelId", () => {
            const registry = new ChannelRegistry();
            registry.push("nonexistent", frame("x")); // must not throw
        });

        it("validateChannelInstanceId rejects invalid channelIds", () => {
            assert.equal(
                validateChannelInstanceId({
                    channelId: "ok-1",
                    manifest: mockManifest,
                    config: {},
                }),
                undefined,
            );
            assert.match(
                validateChannelInstanceId({
                    channelId: "Bad/ID",
                    manifest: mockManifest,
                    config: {},
                }) ?? "",
                /invalid channelId/,
            );
            assert.match(
                validateChannelInstanceId({ channelId: "", manifest: mockManifest, config: {} }) ??
                    "",
                /invalid channelId/,
            );
        });
    });
});

describe("channelReply", () => {
    function eventFrame(message: unknown, type = "message_end"): ServerPush {
        return {
            method: PushMethods.Event,
            workspace: "im://wechat/u1/u1",
            session: "s1",
            params: { event: { type, message } },
        } as unknown as ServerPush;
    }

    describe("extractReplyText", () => {
        it("returns assistant text blocks joined", () => {
            const frame = eventFrame({
                role: "assistant",
                content: [
                    { type: "text", text: "Hello " },
                    { type: "text", text: "world" },
                ],
            });
            assert.equal(extractReplyText(frame), "Hello world");
        });

        it("returns undefined when the assistant content is not a block array", () => {
            // pi-ai 0.83+ always emits AssistantMessage.content as ProtocolContentBlock[].
            // A non-array (e.g. a bare string from an older adapter or a stray null)
            // is treated as "unknown shape" and skipped — no text reaches the peer.
            assert.equal(
                extractReplyText(eventFrame({ role: "assistant", content: "hi" })),
                undefined,
            );
            assert.equal(
                extractReplyText(eventFrame({ role: "assistant", content: null })),
                undefined,
            );
        });

        it("drops thinking blocks", () => {
            const frame = eventFrame({
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "internal reasoning" },
                    { type: "text", text: "answer" },
                ],
            });
            assert.equal(extractReplyText(frame), "answer");
        });

        it("drops toolCall blocks", () => {
            const frame = eventFrame({
                role: "assistant",
                content: [
                    { type: "toolCall", id: "t1", name: "read", arguments: {} },
                    { type: "text", text: "done" },
                ],
            });
            assert.equal(extractReplyText(frame), "done");
        });

        it("returns undefined when only non-text blocks are present", () => {
            const frame = eventFrame({
                role: "assistant",
                content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
            });
            assert.equal(extractReplyText(frame), undefined);
        });

        it("ignores user messages", () => {
            const frame = eventFrame({
                role: "user",
                content: [{ type: "text", text: "my question" }],
            });
            assert.equal(extractReplyText(frame), undefined);
        });

        it("ignores non-message_end events", () => {
            const frame = eventFrame(
                { role: "assistant", content: [{ type: "text", text: "partial" }] },
                "message_start",
            );
            assert.equal(extractReplyText(frame), undefined);
        });

        it("ignores non-session.event push methods", () => {
            const frame = {
                method: PushMethods.ToolCallStart,
                workspace: "im://wechat/u1/u1",
                session: "s1",
                params: {
                    event: { type: "message_end", message: { role: "assistant", content: "x" } },
                },
            } as unknown as ServerPush;
            assert.equal(extractReplyText(frame), undefined);
        });

        it("returns undefined for whitespace-only text", () => {
            assert.equal(
                extractReplyText(eventFrame({ role: "assistant", content: "   " })),
                undefined,
            );
        });

        it("returns the text of an im.tools_enabled frame", () => {
            const frame = {
                method: PushMethods.ImToolsEnabled,
                workspace: "im://wechat/u1/u1",
                session: undefined,
                params: { text: "此对话已启用本地工具。" },
            } as unknown as ServerPush;
            assert.equal(extractReplyText(frame), "此对话已启用本地工具。");
        });

        it("returns undefined for an im.tools_enabled frame without text", () => {
            const frame = {
                method: PushMethods.ImToolsEnabled,
                workspace: "im://wechat/u1/u1",
                session: undefined,
                params: { text: "   " },
            } as unknown as ServerPush;
            assert.equal(extractReplyText(frame), undefined);
        });
    });

    describe("interruptNoticeText", () => {
        it("returns a short, actionable notice", () => {
            const text = interruptNoticeText();
            assert.ok(text.length > 0 && text.length <= 300);
            assert.match(text, /policy change/i);
        });
    });

    describe("chunkText", () => {
        it("returns a single chunk when under the cap", () => {
            assert.deepEqual(chunkText("short", 100), ["short"]);
        });

        it("splits on paragraph boundaries first", () => {
            const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
            const chunks = chunkText(text, 40);
            assert.deepEqual(chunks, ["a".repeat(30), "b".repeat(30)]);
        });

        it("splits on a space when no newline fits", () => {
            const chunks = chunkText(`${"a".repeat(20)} ${"b".repeat(20)}`, 25);
            assert.deepEqual(chunks, ["a".repeat(20), "b".repeat(20)]);
        });

        it("hard-splits a token longer than the cap rather than dropping it", () => {
            const chunks = chunkText("x".repeat(25), 10);
            assert.deepEqual(chunks, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
        });

        it("never emits a chunk over the cap", () => {
            const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
            for (const chunk of chunkText(text, 40)) {
                assert.ok(chunk.length <= 40, `chunk too long: ${chunk.length}`);
            }
        });

        it("preserves all content across chunks", () => {
            const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
            const joined = chunkText(text, 25).join(" ");
            assert.equal(joined, text);
        });
    });

    it("relays the localized command-approval notice and drops frames without one", () => {
        const frame = {
            method: PushMethods.CommandPermissionRequested,
            workspace: "im://wechat/u1/u1",
            session: "s1",
            params: {
                requestId: "r1",
                command: "rm -rf build",
                text: "Approval required. Session: s1",
            },
        } as unknown as ServerPush;
        assert.equal(extractReplyText(frame), "Approval required. Session: s1");
        assert.equal(
            extractReplyText({ ...frame, params: { requestId: "r1", command: "rm -rf build" } }),
            undefined,
        );
        assert.equal(
            extractReplyText({
                ...frame,
                method: PushMethods.CommandPermissionResolved,
                params: {
                    requestId: "r1",
                    approved: false,
                    denialReason: "timeout",
                    text: " Timed out. ",
                },
            }),
            "Timed out.",
        );
    });
});

describe("ingress", () => {
    const WORKSPACE = "im://mock-1/u1/c1";
    const SESSION_ID = "sess-1";

    interface RecordedCall {
        method: string;
        commandId: string | undefined;
    }

    function makeLogger(warnings: string[]): Logger {
        const log: Logger = {
            debug: () => {},
            info: () => {},
            warn: (msg) => {
                warnings.push(msg);
            },
            error: () => {},
            child: () => log,
        };
        return log;
    }

    function makeCtx(
        respond: (req: RpcRequest, calls: RecordedCall[]) => RpcResponse,
        warnings: string[],
    ): { ctx: DefaultChannelContext; calls: RecordedCall[] } {
        const calls: RecordedCall[] = [];
        const hook = {
            dispatchRpc: async (req: RpcRequest): Promise<RpcResponse> => {
                calls.push({ method: req.method, commandId: req.commandId });
                return respond(req, calls);
            },
        } as unknown as ServerRpcSurface;
        const router = {
            route: async () => ({ workspace: WORKSPACE, sessionId: SESSION_ID }),
        } as unknown as ConversationRouter;
        const store: ChannelConfigStore = {
            get: () => undefined,
            set: async () => {},
            clear: async () => {},
        };
        const ctx = new DefaultChannelContext("mock-1", hook, router, store, makeLogger(warnings));
        return { ctx, calls };
    }

    function submit(ctx: DefaultChannelContext, platformMessageId = "msg-1") {
        return ctx.ingress.submit({
            channelId: "mock-1",
            peerId: "u1",
            chatId: "c1",
            platformMessageId,
            text: "hello",
        });
    }

    const ok = (id: string, result: unknown = {}): RpcResponse => ({ id, ok: true, result });
    const err = (id: string, code: string): RpcResponse => ({
        id,
        ok: false,
        error: { code, message: code },
    });

    describe("ingress busy→followUp fallback", () => {
        it("prompt ok → no followUp, no warnings", async () => {
            const warnings: string[] = [];
            const { ctx, calls } = makeCtx((req) => ok(req.id), warnings);
            await submit(ctx);
            assert.deepEqual(
                calls.map((c) => c.method),
                ["session.prompt"],
            );
            assert.deepEqual(warnings, []);
        });

        it("prompt session_busy → followUp enqueues (mode queued), no retry", async () => {
            const warnings: string[] = [];
            const { ctx, calls } = makeCtx((req) => {
                if (req.method === "session.prompt") return err(req.id, "session_busy");
                return ok(req.id, { mode: "queued" });
            }, warnings);
            const res = await submit(ctx);
            assert.equal(res.sessionId, SESSION_ID);
            assert.deepEqual(
                calls.map((c) => c.method),
                ["session.prompt", "session.followUp"],
            );
            // The follow-up gets its own commandId so dedup cannot replay the
            // prompt's cached busy outcome.
            assert.equal(calls[1]?.commandId, "msg-1:followUp");
            assert.deepEqual(warnings, []);
        });

        it("prompt busy → followUp idle (run ended) → prompt retried once with a fresh commandId", async () => {
            const warnings: string[] = [];
            const { ctx, calls } = makeCtx((req, prev) => {
                if (req.method === "session.followUp") return ok(req.id, { mode: "idle" });
                // First prompt is busy; the retry succeeds.
                if (req.method === "session.prompt" && prev.length === 1) {
                    return err(req.id, "session_busy");
                }
                return ok(req.id);
            }, warnings);
            await submit(ctx);
            assert.deepEqual(
                calls.map((c) => c.method),
                ["session.prompt", "session.followUp", "session.prompt"],
            );
            assert.equal(calls[2]?.commandId, "msg-1:retry");
            assert.deepEqual(warnings, []);
        });

        it("followUp fallback rejected → warn logged, no retry", async () => {
            const warnings: string[] = [];
            const { ctx, calls } = makeCtx((req) => {
                if (req.method === "session.prompt") return err(req.id, "session_busy");
                return err(req.id, "internal");
            }, warnings);
            await submit(ctx);
            assert.deepEqual(
                calls.map((c) => c.method),
                ["session.prompt", "session.followUp"],
            );
            assert.equal(warnings.length, 1);
            assert.match(warnings[0] ?? "", /followUp fallback rejected/);
        });

        it("prompt failure other than busy → warn logged, no followUp", async () => {
            const warnings: string[] = [];
            const { ctx, calls } = makeCtx((req) => err(req.id, "internal"), warnings);
            await submit(ctx);
            assert.deepEqual(
                calls.map((c) => c.method),
                ["session.prompt"],
            );
            assert.equal(warnings.length, 1);
            assert.match(warnings[0] ?? "", /prompt rejected/);
        });
    });
});

describe("clientSinkFanout", () => {
    const mockChannelConfig: ChannelConfig = {
        channelId: "mock-1",
        manifest: mockChannelManifest,
        config: {},
    };

    useTempTacoHome("client-sink");
    stubModelFetch();

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
                workspace: asWorkspaceId("im://ch/u/c"),
                session: asSessionId("s"),
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
        const handle = (await channel.start(
            owner.buildChannelContext("mock-1"),
        )) as MockChannelHandle;
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

                // Wait until the host's emitPush has delivered its first
                // im:// frame to the non-owner's transport. Without the
                // registry, nonOwnerTransport stays empty — the regression
                // Phase 1 introduced and Phase 2 closes.
                const frames = await nonOwnerTransport.waitForPushCount(1, 5000);
                const imFrames = frames.filter(
                    (f) =>
                        (f as ServerPush).workspace === "im://mock-1/u1/c1" &&
                        (f as ServerPush).session === sessionId,
                );
                assert.ok(
                    imFrames.length >= 1,
                    `expected at least one im:// push frame on the desktop transport; got ${frames.length} frame(s)`,
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
});
