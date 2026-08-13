import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerPush } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import type {
    IncomingLike,
    SdkLoginCallbacks,
    WeChatBotFactoryOptions,
    WeChatBotLike,
} from "../../src/channels/builtin/wechatChannel.ts";
import { WeChatChannel } from "../../src/channels/builtin/wechatChannel.ts";
import { interruptNoticeText } from "../../src/channels/builtin/wechatReply.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";
import type {
    ChannelConfigStore,
    ChannelContext,
    ChannelInboundMessage,
    Logger,
} from "../../src/channels/types.ts";

function silentLogger(): Logger {
    const l: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        child: () => l,
    };
    return l;
}

function memoryStore(initial: Record<string, unknown> = {}): ChannelConfigStore {
    const map = new Map(Object.entries(initial));
    return {
        get: <T>(name: string) => map.get(name) as T | undefined,
        set: async <T>(name: string, value: T) => {
            if (value === undefined) map.delete(name);
            else map.set(name, value);
        },
        clear: async () => map.clear(),
    };
}

class FakeBot implements WeChatBotLike {
    loginCalls = 0;
    startCalls = 0;
    stopCalls = 0;
    readonly sent: { userId: string; text: string }[] = [];
    private messageHandler?: (msg: IncomingLike) => void | Promise<void>;
    private readonly listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    isRunning = false;

    /** Callbacks seen by each login() call — the SDK ignores constructor ones. */
    readonly loginCallbacks: (SdkLoginCallbacks | undefined)[] = [];

    async login(options?: { force?: boolean; callbacks?: SdkLoginCallbacks }): Promise<unknown> {
        this.loginCalls += 1;
        this.loginCallbacks.push(options?.callbacks);
        return {};
    }
    async start(): Promise<void> {
        this.startCalls += 1;
        this.isRunning = true;
    }
    stop(): void {
        this.stopCalls += 1;
        this.isRunning = false;
    }
    async send(userId: string, text: string): Promise<void> {
        this.sent.push({ userId, text });
    }
    onMessage(handler: (msg: IncomingLike) => void | Promise<void>): unknown {
        this.messageHandler = handler;
        return this;
    }
    on(event: string, handler: (...a: unknown[]) => void): unknown {
        const list = this.listeners.get(event) ?? [];
        list.push(handler);
        this.listeners.set(event, list);
        return this;
    }
    emit(event: string, ...args: unknown[]): void {
        for (const h of this.listeners.get(event) ?? []) h(...args);
    }
    async deliver(msg: IncomingLike): Promise<void> {
        await this.messageHandler?.(msg);
    }
}

interface Harness {
    channel: WeChatChannel;
    ctx: ChannelContext;
    broker: ChannelBindBroker;
    bot: FakeBot;
    submitted: ChannelInboundMessage[];
}

function harness(
    opts: { credentials?: boolean; peer?: string; listPeers?: string[] } = {},
): Harness {
    const bot = new FakeBot();
    const broker = new ChannelBindBroker();
    const submitted: ChannelInboundMessage[] = [];
    const channel = new WeChatChannel({
        broker,
        resolvePeer: () => opts.peer,
        createBot: (_o: WeChatBotFactoryOptions) => bot,
        listPeers: (_channelId: string) => opts.listPeers ?? [],
    });
    const ctx: ChannelContext = {
        channelId: "wechat",
        logger: silentLogger(),
        config: memoryStore(opts.credentials ? { credentials: { token: "t" } } : {}),
        ingress: {
            submit: async (msg) => {
                submitted.push(msg);
                return { sessionId: "s1" };
            },
        },
    };
    return { channel, ctx, broker, bot, submitted };
}

function replyFrame(text: string, session = "s1"): ServerPush {
    return {
        method: PushMethods.Event,
        workspace: "im://wechat/u1/u1",
        session,
        params: {
            event: {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text }] },
            },
        },
    } as unknown as ServerPush;
}

describe("WeChatChannel.start", () => {
    it("returns a handle without awaiting login", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        assert.ok(handle);
        // No credentials: must not attempt login, must idle in unbound.
        assert.equal(h.bot.loginCalls, 0);
        assert.equal(h.broker.status("wechat").state, "unbound");
    });

    it("auto-reconnects in the background when credentials exist", async () => {
        const h = harness({ credentials: true });
        await h.channel.start(h.ctx);
        assert.equal(h.broker.status("wechat").state, "connecting");
        // Login is fire-and-forget; drain the microtask queue to observe it.
        await new Promise((r) => setImmediate(r));
        assert.equal(h.bot.loginCalls, 1);
        assert.equal(h.bot.startCalls, 1);
    });

    /**
     * Regression guard: the SDK's client.login() forwards only its own
     * options.callbacks and ignores constructor loginCallbacks, so passing them
     * at construction time means onQrUrl never fires and a bind hangs until the
     * HTTP layer times out. Assert they arrive via login().
     */
    it("passes QR callbacks through login(), not the constructor", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        await handle.login?.();

        assert.equal(h.bot.loginCallbacks.length, 1);
        const callbacks = h.bot.loginCallbacks[0];
        assert.ok(callbacks, "login() received no callbacks — QR would never surface");
        assert.equal(typeof callbacks.onQrUrl, "function");
        assert.equal(typeof callbacks.onVerifyCode, "function");
    });

    it("publishes the QR url through the broker", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        await handle.login?.();

        const callbacks = h.bot.loginCallbacks[0];
        assert.ok(callbacks);
        callbacks.onQrUrl("https://qr.example/xyz");

        const status = h.broker.status("wechat");
        assert.equal(status.state, "awaiting_scan");
        assert.equal(status.qrUrl, "https://qr.example/xyz");
    });

    it("routes onVerifyCode to the broker so the client can answer", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        await handle.login?.();

        const callbacks = h.bot.loginCallbacks[0];
        assert.ok(callbacks);
        const pending = callbacks.onVerifyCode(false);

        const requestId = h.broker.status("wechat").requestId;
        assert.ok(requestId, "no requestId published — client cannot submit a code");
        assert.equal(h.broker.submitVerifyCode(requestId, "123456"), true);
        assert.equal(await pending, "123456");
    });

    it("maps bot error events onto broker error state", async () => {
        const h = harness();
        await h.channel.start(h.ctx);
        h.bot.emit("error", new Error("poll exploded"));
        const status = h.broker.status("wechat");
        assert.equal(status.state, "error");
        assert.equal(status.message, "poll exploded");
    });
});

describe("WeChatChannel inbound", () => {
    it("uses the peer's own id as chatId for a 1:1 chat", async () => {
        const h = harness();
        await h.channel.start(h.ctx);
        await h.bot.deliver({
            userId: "u1",
            text: "hi",
            raw: { message_id: 7, create_time_ms: 1_700_000_000_007 },
        });

        assert.equal(h.submitted.length, 1);
        assert.equal(h.submitted[0].peerId, "u1");
        assert.equal(h.submitted[0].chatId, "u1");
        assert.equal(h.submitted[0].platformMessageId, "7");
        assert.equal(h.submitted[0].text, "hi");
    });

    it("uses group_id as chatId so a group shares one session", async () => {
        const h = harness();
        await h.channel.start(h.ctx);
        await h.bot.deliver({
            userId: "u1",
            text: "hi",
            raw: { group_id: "g9", message_id: 8, create_time_ms: 1_700_000_000_008 },
        });

        assert.equal(h.submitted[0].peerId, "u1");
        assert.equal(h.submitted[0].chatId, "g9");
    });

    /**
     * Regression guard: iLink sends group_id as "" (not undefined) for 1:1
     * chats. `??` lets "" through, and an empty chatId builds a workspace key
     * parseImCwd cannot parse — the session gets created but replies are
     * silently dropped because no peer resolves for it.
     */
    it("treats an empty or blank group_id as a 1:1 chat", async () => {
        const h = harness();
        await h.channel.start(h.ctx);
        await h.bot.deliver({
            userId: "u1",
            text: "a",
            raw: { group_id: "", message_id: 1, create_time_ms: 1_700_000_000_001 },
        });
        await h.bot.deliver({
            userId: "u2",
            text: "b",
            raw: { group_id: "   ", message_id: 2, create_time_ms: 1_700_000_000_002 },
        });

        assert.equal(h.submitted[0].chatId, "u1");
        assert.equal(h.submitted[1].chatId, "u2");
    });

    /**
     * Regression guard: iLink's wire contract always carries `message_id`
     * (the type system now enforces this — see IncomingBaseLike). But the
     * platformMessageId fallback chain defends against an SDK upgrade that
     * drops the field. The chain walks `message_id` → `client_id` →
     * `seq` → `create_time_ms`, so we exercise each step by omitting
     * all higher-priority fields.
     */
    it("falls back through client_id, seq, create_time_ms when message_id is absent", async () => {
        const h = harness();
        await h.channel.start(h.ctx);
        await h.bot.deliver({
            userId: "u1",
            text: "client_id wins",
            // Cast past IncomingLike: this case is only reachable when an
            // SDK regression drops message_id, which the new type contract
            // would forbid. The fallback chain still defends against it.
            raw: { group_id: "g1", client_id: "c-42", create_time_ms: 1_700_000_000_001 } as never,
        });
        await h.bot.deliver({
            userId: "u1",
            text: "seq wins",
            // Cast past IncomingLike: this case is only reachable when an
            // SDK regression drops message_id, which the new type contract
            // would forbid. The fallback chain still defends against it.
            raw: { group_id: "g1", seq: 17, create_time_ms: 1_700_000_000_002 } as never,
        });
        await h.bot.deliver({
            userId: "u1",
            text: "create_time_ms wins",
            raw: { group_id: "g1", create_time_ms: 1_700_000_000_003 } as never,
        });
        assert.equal(h.submitted[0].platformMessageId, "c-42");
        assert.equal(h.submitted[1].platformMessageId, "17");
        assert.equal(h.submitted[2].platformMessageId, "u1-g1-1700000000003");
        // Note: the "all empty" branch (no message_id, no client_id, no seq,
        // no create_time_ms) is no longer reachable in production tests because
        // IncomingBaseLike makes message_id and create_time_ms required. The
        // template-string fallback `${peerId}-${chatId}-${...}` is
        // still in the production code as a final safety net; if the SDK
        // regresses in the future, the `as unknown as IncomingLike` cast
        // in a new test could exercise it. The other three branches cover
        // the realistic partial-regression scenarios.
    });

    it("does not throw when ingress rejects", async () => {
        const h = harness();
        h.ctx.ingress.submit = async () => {
            throw new Error("router down");
        };
        await h.channel.start(h.ctx);
        await h.bot.deliver({
            userId: "u1",
            text: "hi",
            raw: { message_id: 1, create_time_ms: 1_700_000_000_001 },
        });
        // Reaching here without throwing is the assertion.
    });
});

describe("WeChatChannel outbound", () => {
    it("sends the assistant reply to the resolved peer", async () => {
        const h = harness({ peer: "u1" });
        const handle = await h.channel.start(h.ctx);
        await handle.push(replyFrame("the answer"));

        assert.deepEqual(h.bot.sent, [{ userId: "u1", text: "the answer" }]);
    });

    it("drops the reply when no peer can be resolved", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        await handle.push(replyFrame("the answer"));

        assert.deepEqual(h.bot.sent, []);
    });

    it("ignores frames carrying no assistant text", async () => {
        const h = harness({ peer: "u1" });
        const handle = await h.channel.start(h.ctx);
        await handle.push({
            method: PushMethods.ToolCallStart,
            workspace: "im://wechat/u1/u1",
            session: "s1",
            params: {},
        } as unknown as ServerPush);

        assert.deepEqual(h.bot.sent, []);
    });

    it("splits an over-long reply into multiple sends", async () => {
        const h = harness({ peer: "u1" });
        const handle = await h.channel.start(h.ctx);
        await handle.push(replyFrame("x".repeat(5000)));

        assert.ok(h.bot.sent.length > 1);
        for (const s of h.bot.sent) assert.ok(s.text.length <= 2048);
    });

    it("broadcasts the interrupt notice to every peer on im.workspaces_invalidated", async () => {
        const h = harness({ listPeers: ["u1", "u2"] });
        const handle = await h.channel.start(h.ctx);
        await handle.push({
            method: PushMethods.ImWorkspacesInvalidated,
            workspace: "im://wechat/u1/c1",
            params: { channelId: "wechat", interruptedCount: 1 },
        } as unknown as ServerPush);

        const text = interruptNoticeText();
        assert.deepEqual(h.bot.sent, [
            { userId: "u1", text },
            { userId: "u2", text },
        ]);
    });

    it("broadcasts nothing on im.workspaces_invalidated when no peers are routed", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        await handle.push({
            method: PushMethods.ImWorkspacesInvalidated,
            workspace: "im://wechat/u1/c1",
            params: { channelId: "wechat" },
        } as unknown as ServerPush);

        assert.deepEqual(h.bot.sent, []);
    });

    it("close stops the bot and cancels pending binds", async () => {
        const h = harness();
        const handle = await h.channel.start(h.ctx);
        const pending = h.broker.requestVerifyCode("wechat", false);

        await handle.close();

        assert.equal(h.bot.stopCalls, 1);
        await assert.rejects(pending, /channel closing/);
    });
});
