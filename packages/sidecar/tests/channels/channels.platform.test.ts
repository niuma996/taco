import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ChannelsBindCreds, ServerPush } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import { interruptNoticeText } from "../../src/channels/builtin/channelReply.ts";
import type { MockChannelHandle } from "../../src/channels/builtin/mockChannel.ts";
import { MockChannel } from "../../src/channels/builtin/mockChannel.ts";
import type {
    DownloadedMediaLike,
    IncomingLike,
    SdkLoginCallbacks,
    WeChatBotFactoryOptions,
    WeChatBotLike,
} from "../../src/channels/builtin/wechatChannel.ts";
import { WeChatChannel } from "../../src/channels/builtin/wechatChannel.ts";
import type {
    WeComChannelHandle,
    WeComClientFactoryOptions,
    WeComClientLike,
    WeComMediaFrameLike,
    WeComTextFrameLike,
} from "../../src/channels/builtin/wecomChannel.ts";
import { WeComChannel } from "../../src/channels/builtin/wecomChannel.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";
import type {
    ChannelConfigStore,
    ChannelContext,
    ChannelInboundMessage,
    Logger,
} from "../../src/channels/types.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { stubModelFetch } from "../_helpers/stubModelFetch.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("wechatChannel", () => {
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

        async login(options?: {
            force?: boolean;
            callbacks?: SdkLoginCallbacks;
        }): Promise<unknown> {
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
        /** What the next download call returns; null means "no media". */
        downloadResult: DownloadedMediaLike | null = null;
        async download(): Promise<DownloadedMediaLike | null> {
            return this.downloadResult;
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
        /** The channel's batch window; `deliver` waits it out before returning. */
        quietMs = 0;

        async deliver(msg: IncomingLike): Promise<void> {
            await this.messageHandler?.(msg);
            // Batched submits land on a timer, not on the handler's return.
            await new Promise((resolve) => setTimeout(resolve, this.quietMs + 5));
        }
    }

    interface Harness {
        channel: WeChatChannel;
        ctx: ChannelContext;
        broker: ChannelBindBroker;
        bot: FakeBot;
        submitted: ChannelInboundMessage[];
        /** The storage adapter handed to the SDK; set once start() runs. */
        factoryOpts?: WeChatBotFactoryOptions;
    }

    function harness(
        opts: { credentials?: boolean; peer?: string; listPeers?: string[]; logger?: Logger } = {},
    ): Harness {
        const bot = new FakeBot();
        const broker = new ChannelBindBroker();
        const submitted: ChannelInboundMessage[] = [];
        const h = {} as Harness;
        const channel = new WeChatChannel({
            broker,
            resolveRoute: () =>
                opts.peer === undefined
                    ? undefined
                    : { channelId: "wechat", peerId: opts.peer, chatId: opts.peer },
            createBot: (o: WeChatBotFactoryOptions) => {
                h.factoryOpts = o;
                return bot;
            },
            listPeers: (_channelId: string) => opts.listPeers ?? [],
            mergeWindowMs: 0,
        });
        const ctx: ChannelContext = {
            channelId: "wechat",
            logger: opts.logger ?? silentLogger(),
            config: memoryStore(opts.credentials ? { credentials: { token: "t" } } : {}),
            ingress: {
                submit: async (msg) => {
                    submitted.push(msg);
                    return { sessionId: "s1" };
                },
            },
        };
        return Object.assign(h, { channel, ctx, broker, bot, submitted });
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

        // The SDK poller retries network errors forever but emits nothing when a
        // poll succeeds again; the cursor write after each good poll is the signal.
        it("recovers from a poll error to connected once the cursor advances", async () => {
            const h = harness({ credentials: true });
            await h.channel.start(h.ctx);
            h.bot.emit("poll:start");
            h.bot.emit("error", new Error("Network error: fetch failed"));
            assert.equal(h.broker.status("wechat").state, "error");

            await h.factoryOpts?.storage.set("cursor", "next");
            assert.equal(h.broker.status("wechat").state, "connected");
        });

        it("recovers from a poll error to connected on an inbound message", async () => {
            const h = harness({ credentials: true });
            await h.channel.start(h.ctx);
            h.bot.emit("error", new Error("Network error: fetch failed"));
            await h.bot.deliver({
                userId: "u1",
                text: "hi",
                raw: { message_id: 1, create_time_ms: 1 },
            });
            assert.equal(h.broker.status("wechat").state, "connected");
        });

        it("a cursor write does not override a bind in progress", async () => {
            const h = harness();
            const handle = await h.channel.start(h.ctx);
            await handle.login?.();
            h.bot.loginCallbacks[0]?.onQrUrl("https://qr.example/xyz");

            await h.factoryOpts?.storage.set("cursor", "next");
            assert.equal(h.broker.status("wechat").state, "awaiting_scan");
        });
    });

    describe("WeChatChannel media", () => {
        it("downloads an inbound image and submits it as media", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = { data: Buffer.from("PNGBYTES"), type: "image" };
            await h.bot.deliver({
                userId: "u1",
                text: "[image]",
                images: [{}],
                raw: { message_id: 9, create_time_ms: 1_700_000_000_009 },
            });
            assert.equal(h.submitted.length, 1);
            const msg = h.submitted[0];
            assert.equal(msg.kind, "media");
            // The placeholder text would only be noise the model reads past.
            assert.equal(msg.text, "");
            assert.equal(msg.media?.[0].kind, "image");
            assert.equal(msg.media?.[0].source.kind, "base64");
        });

        it("drops the media url the SDK puts in a media message's text", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = { data: Buffer.from("PNGBYTES"), type: "image" };
            // The SDK derives the text of an image item from its CDN url, so
            // an image-only message arrives carrying that url.
            await h.bot.deliver({
                userId: "u1",
                text: "https://mmunion.qpic.cn/abc123/0",
                images: [{}],
                raw: { message_id: 12, create_time_ms: 1_700_000_000_012 },
            });
            // The url is not something the sender wrote; it is the media.
            assert.equal(h.submitted[0]?.text, "");
            assert.equal(h.submitted[0]?.media?.length, 1);
        });

        it("keeps the caption that sits beside the media url", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = { data: Buffer.from("PNGBYTES"), type: "image" };
            // The SDK joins the message's items: caption, then the media url.
            await h.bot.deliver({
                userId: "u1",
                text: "what does this chart say?\nhttps://mmunion.qpic.cn/abc123/0",
                images: [{}],
                raw: { message_id: 13, create_time_ms: 1_700_000_000_013 },
            });
            assert.equal(h.submitted[0]?.text, "what does this chart say?");
            assert.equal(h.submitted[0]?.media?.length, 1);
        });

        it("drops the file name of a media item the downloader skipped", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = { data: Buffer.from("PNGBYTES"), type: "image" };
            // One message can carry several items, but download() returns the
            // first media only — the SDK's text still names the file it did
            // not deliver, so that line must go too.
            await h.bot.deliver({
                userId: "u1",
                text: "https://mmunion.qpic.cn/abc123/0\nreport.pdf",
                images: [{}],
                files: [{ fileName: "report.pdf" }],
                raw: { message_id: 14, create_time_ms: 1_700_000_000_014 },
            });
            assert.equal(h.submitted[0]?.text, "");
            assert.equal(h.submitted[0]?.media?.length, 1);
        });

        it("keeps a real caption on a media message", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = { data: Buffer.from("PNGBYTES"), type: "image" };
            await h.bot.deliver({
                userId: "u1",
                text: "what does this chart say?",
                images: [{}],
                raw: { message_id: 10, create_time_ms: 1_700_000_000_010 },
            });
            // Words the sender wrote are content, not a placeholder.
            assert.equal(h.submitted[0]?.text, "what does this chart say?");
            assert.equal(h.submitted[0]?.media?.length, 1);
        });

        it("drops a caption that only repeats the file name", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = {
                data: Buffer.from("%PDF-1.7"),
                type: "file",
                fileName: "report.pdf",
            };
            await h.bot.deliver({
                userId: "u1",
                text: "report.pdf",
                files: [{}],
                raw: { message_id: 11, create_time_ms: 1_700_000_000_011 },
            });
            assert.equal(h.submitted[0]?.text, "");
            assert.equal(h.submitted[0]?.media?.[0].name, "report.pdf");
        });

        it("keeps the platform file name when it submits a file", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = {
                data: Buffer.from("%PDF-1.7"),
                type: "file",
                fileName: "report.pdf",
            };
            await h.bot.deliver({
                userId: "u1",
                text: "report.pdf",
                files: [{}],
                raw: { message_id: 10, create_time_ms: 1_700_000_000_010 },
            });
            assert.equal(h.submitted.length, 1);
            assert.equal(h.submitted[0].media?.[0].kind, "file");
            assert.equal(h.submitted[0].media?.[0].name, "report.pdf");
        });

        it("submits a picture and the words sent with it as one prompt", async () => {
            // The platform delivers them as two messages, and the poller does
            // not wait for one batch before emitting the next. One prompt per
            // message starts a run on whichever arrives first and demotes the
            // other to a follow-up the model only sees after answering.
            const h = harness();
            await h.channel.start(h.ctx);
            let release: () => void = () => {};
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            h.bot.download = async () => {
                await gate;
                return { data: Buffer.from("PNGBYTES"), type: "image" };
            };
            const image = h.bot.deliver({
                userId: "u1",
                text: "[image]",
                images: [{}],
                raw: { message_id: 20, create_time_ms: 1_700_000_000_020 },
            });
            const caption = h.bot.deliver({
                userId: "u1",
                text: "what is in the picture",
                raw: { message_id: 21, create_time_ms: 1_700_000_000_021 },
            });
            release();
            await Promise.all([image, caption]);
            assert.equal(h.submitted.length, 1, "one prompt, not two messages");
            const msg = h.submitted[0];
            assert.equal(msg.text, "what is in the picture");
            assert.equal(msg.kind, "media");
            assert.equal(msg.media?.[0].kind, "image");
        });

        it("keeps a caption that arrives during a slow download in the same batch", async () => {
            // A large file takes a while to download, and the platform
            // delivers the caption that belongs to it only after the download
            // finishes. A batch that closed on a timer would leave that
            // caption to start a second turn.
            const h = harness();
            await h.channel.start(h.ctx);
            let release: () => void = () => {};
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            h.bot.download = async () => {
                await gate;
                return { data: Buffer.from("PNGBYTES"), type: "image" };
            };
            const image = h.bot.deliver({
                userId: "u1",
                text: "[image]",
                images: [{}],
                raw: { message_id: 30, create_time_ms: 1_700_000_000_030 },
            });
            // Let the batch's window lapse while the download is still
            // running — that is when a timer-driven close would drop the
            // batch and strand the caption in a second one.
            await new Promise((resolve) => setTimeout(resolve, 20));
            const caption = h.bot.deliver({
                userId: "u1",
                text: "what is in the picture",
                raw: { message_id: 31, create_time_ms: 1_700_000_000_031 },
            });
            release();
            await Promise.all([image, caption]);
            assert.equal(h.submitted.length, 1, "one prompt, not two turns");
            assert.equal(h.submitted[0].text, "what is in the picture");
            assert.equal(h.submitted[0].kind, "media");
        });

        it("keeps different senders in one group as separate prompts", async () => {
            // The group shares a session, but two people writing are two turns;
            // merging them would make the agent answer both as one message.
            const h = harness();
            await h.channel.start(h.ctx);
            h.bot.downloadResult = { data: Buffer.from("PNGBYTES"), type: "image" };
            await h.bot.deliver({
                userId: "u1",
                text: "[image]",
                images: [{}],
                raw: { message_id: 22, group_id: "g1", create_time_ms: 1_700_000_000_022 },
            });
            await h.bot.deliver({
                userId: "u2",
                text: "hello",
                raw: { message_id: 23, group_id: "g1", create_time_ms: 1_700_000_000_023 },
            });
            assert.deepEqual(
                h.submitted.map((m) => m.peerId),
                ["u1", "u2"],
            );
        });

        it("drops a media message whose download fails", async () => {
            const warns: string[] = [];
            const logger: Logger = {
                debug: () => {},
                info: () => {},
                warn: (msg) => warns.push(msg),
                error: () => {},
                child: () => logger,
            };
            const h = harness({ logger });
            await h.channel.start(h.ctx);
            h.bot.download = async () => {
                throw new Error("expired");
            };
            await h.bot.deliver({
                userId: "u1",
                text: "[image]",
                images: [{}],
                raw: { message_id: 11, create_time_ms: 1_700_000_000_011 },
            });
            assert.equal(h.submitted.length, 0);
            assert.match(warns.join("\n"), /11/);
            assert.equal(warns.join("\n").includes("u1"), false);
        });
    });

    describe("WeChatChannel inbound", () => {
        // One harness, four shapes of `raw.group_id` — it is the chat id, so a
        // group shares one session while a 1:1 falls back to the peer's own id.
        it("routes by raw.group_id: the group id for a group, the peer's own id for 1:1", async () => {
            const h = harness();
            await h.channel.start(h.ctx);
            await h.bot.deliver({
                userId: "u1",
                text: "hi",
                raw: { message_id: 7, create_time_ms: 1_700_000_000_007 },
            });
            await h.bot.deliver({
                userId: "u1",
                text: "hi",
                raw: { group_id: "g9", message_id: 8, create_time_ms: 1_700_000_000_008 },
            });
            // Regression guard: iLink sends group_id as "" (not undefined) for 1:1
            // chats. `??` lets "" through, and an empty chatId builds a workspace key
            // parseImCwd cannot parse — the session gets created but replies are
            // silently dropped because no peer resolves for it.
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

            assert.equal(h.submitted.length, 4);
            assert.equal(h.submitted[0].peerId, "u1");
            assert.equal(h.submitted[0].chatId, "u1");
            assert.equal(h.submitted[0].platformMessageId, "7");
            assert.equal(h.submitted[0].text, "hi");
            assert.equal(h.submitted[1].peerId, "u1");
            assert.equal(h.submitted[1].chatId, "g9");
            assert.equal(h.submitted[2].chatId, "u1");
            assert.equal(h.submitted[3].chatId, "u2");
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
                raw: {
                    group_id: "g1",
                    client_id: "c-42",
                    create_time_ms: 1_700_000_000_001,
                } as never,
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
});

describe("wecomChannel", () => {
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

    interface SentMessage {
        chatid: string;
        body: { msgtype: string; markdown?: { content: string } };
    }

    class FakeClient extends EventEmitter implements WeComClientLike {
        connectCalls = 0;
        disconnectCalls = 0;
        readonly sent: SentMessage[] = [];
        /** Credentials this instance was constructed with — mirrors the real
         *  WSClient, which copies them once in its constructor. */
        constructor(readonly opts: WeComClientFactoryOptions) {
            super();
        }
        connect(): unknown {
            this.connectCalls += 1;
            return this;
        }
        disconnect(): void {
            this.disconnectCalls += 1;
        }
        async sendMessage(
            chatid: string,
            body: { msgtype: string; markdown?: { content: string } },
        ): Promise<unknown> {
            this.sent.push({ chatid, body });
            return {};
        }
        /** The channel's batch window; deliver helpers wait it out. */
        quietMs = 0;
        /** Batched submits land on a timer, not on the emit. */
        private async settle(): Promise<void> {
            await new Promise((resolve) => setTimeout(resolve, this.quietMs + 5));
        }
        /** Test helper — emit a typed message.text frame. */
        async deliverText(frame: WeComTextFrameLike): Promise<void> {
            this.emit("message.text", frame);
            await this.settle();
        }
        /** What the next downloadFile call returns. */
        downloadResult: { buffer: Buffer; filename?: string } = { buffer: Buffer.alloc(0) };
        /** The arguments the last downloadFile call received. */
        lastDownload?: { url: string; aesKey?: string };
        async downloadFile(
            url: string,
            aesKey?: string,
        ): Promise<{ buffer: Buffer; filename?: string }> {
            this.lastDownload = { url, aesKey };
            return this.downloadResult;
        }
        /** Test helper — emit an image frame. */
        async deliverImage(frame: WeComMediaFrameLike): Promise<void> {
            this.emit("message.image", frame);
            await this.settle();
        }
        /** Test helper — emit a file frame. */
        async deliverFile(frame: WeComMediaFrameLike): Promise<void> {
            this.emit("message.file", frame);
            await this.settle();
        }
        /** Test helper — emit the SDK's authenticated success. */
        markAuthenticated(): void {
            this.emit("authenticated");
        }
        markDisconnected(reason: string): void {
            this.emit("disconnected", reason);
        }
    }

    interface Harness {
        channel: WeComChannel;
        ctx: ChannelContext;
        broker: ChannelBindBroker;
        /** Every client the channel built, in creation order — the fix under test
         *  is that a reconnect builds a new one carrying the new credentials. */
        clients: FakeClient[];
        /** The current (last-built) client; throws when none exists yet. */
        readonly client: FakeClient;
        submitted: ChannelInboundMessage[];
        store: Map<string, unknown>;
    }

    function harness(
        opts: {
            credentials?: ChannelsBindCreds;
            route?: { channelId: string; peerId: string; chatId: string };
            logger?: Logger;
        } = {},
    ): Harness {
        const clients: FakeClient[] = [];
        const broker = new ChannelBindBroker();
        const submitted: ChannelInboundMessage[] = [];
        const store = new Map<string, unknown>(
            opts.credentials ? Object.entries({ credentials: opts.credentials }) : [],
        );
        const channel = new WeComChannel({
            broker,
            resolveRoute: () => opts.route,
            createClient: (o: WeComClientFactoryOptions) => {
                const c = new FakeClient(o);
                clients.push(c);
                return c;
            },
            mergeWindowMs: 0,
        });
        const ctx: ChannelContext = {
            channelId: "wecom",
            logger: opts.logger ?? silentLogger(),
            config: {
                get: <T>(name: string) => store.get(name) as T | undefined,
                set: async <T>(name: string, value: T) => {
                    if (value === undefined) store.delete(name);
                    else store.set(name, value);
                },
                clear: async () => store.clear(),
            },
            ingress: {
                submit: async (msg) => {
                    submitted.push(msg);
                    return { sessionId: "s1" };
                },
            },
        };
        return {
            channel,
            ctx,
            broker,
            clients,
            get client() {
                const c = clients.at(-1);
                if (!c) throw new Error("no client built yet");
                return c;
            },
            submitted,
            store,
        };
    }

    function replyFrame(text: string, session = "s1"): ServerPush {
        return {
            method: PushMethods.Event,
            workspace: "im://wecom/u1/u1",
            session,
            params: {
                event: {
                    type: "message_end",
                    message: { role: "assistant", content: [{ type: "text", text }] },
                },
            },
        } as ServerPush;
    }

    describe("WeComChannel", () => {
        it("starts unbound and builds no client when no stored credentials", async () => {
            const h = harness();
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            assert.equal(h.broker.status("wecom").state, "unbound");
            assert.equal(h.clients.length, 0);
            await handle.close();
        });

        it("auto-connects when stored credentials are present and reports connected on authenticate", async () => {
            const h = harness({ credentials: { botId: "b1", secret: "s1" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            assert.equal(h.broker.status("wecom").state, "connecting");
            assert.equal(h.client.connectCalls, 1);
            assert.equal(h.client.opts.botId, "b1");
            assert.equal(h.client.opts.secret, "s1");
            h.client.markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");
            await handle.close();
        });

        // One harness, three shapes of `chatid`: a group keeps the SDK-provided id
        // so the whole group shares one session, a 1:1 falls back to the peer's own
        // id (aibot sends `chatid` as "" there).
        it("routes an inbound text message with msgid as platformMessageId, chatid falling back to the peer userid for 1:1 chats", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await h.client.deliverText({
                body: {
                    msgid: "m-123",
                    chattype: "single",
                    from: { userid: "u1" },
                    text: { content: "hello" },
                },
            });
            await h.client.deliverText({
                body: {
                    msgid: "m-empty",
                    chatid: "",
                    chattype: "single",
                    from: { userid: "u1" },
                    text: { content: "hi" },
                },
            });
            await h.client.deliverText({
                body: {
                    msgid: "m-grp",
                    chatid: "g-77",
                    chattype: "group",
                    from: { userid: "u2" },
                    text: { content: "team" },
                },
            });
            // Wait one microtask for the void promise.
            await new Promise((r) => setImmediate(r));
            assert.equal(h.submitted.length, 3);
            assert.deepEqual(h.submitted[0], {
                platformMessageId: "m-123",
                channelId: "wecom",
                peerId: "u1",
                chatId: "u1",
                kind: "text",
                text: "hello",
            });
            assert.equal(h.submitted[1].chatId, "u1");
            assert.equal(h.submitted[2].chatId, "g-77");
            await handle.close();
        });

        it("submits a picture and the words sent with it as one prompt", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.downloadResult = { buffer: Buffer.from("PNGBYTES") };
            // The platform sends them as two frames; emitted together, they
            // belong to one user turn.
            const image = h.client.deliverImage({
                body: {
                    msgid: "m-img",
                    chatid: "g-1",
                    from: { userid: "u1" },
                    image: { url: "https://example.test/i", aeskey: "key-1" },
                },
            });
            const text = h.client.deliverText({
                body: {
                    msgid: "m-cap",
                    chatid: "g-1",
                    chattype: "group",
                    from: { userid: "u1" },
                    text: { content: "what is this" },
                },
            });
            await Promise.all([image, text]);
            assert.equal(h.submitted.length, 1);
            assert.equal(h.submitted[0].text, "what is this");
            assert.equal(h.submitted[0].kind, "media");
            assert.equal(h.submitted[0].media?.[0].kind, "image");
            await handle.close();
        });

        it("keeps different senders in one group as separate prompts", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.downloadResult = { buffer: Buffer.from("PNGBYTES") };
            const image = h.client.deliverImage({
                body: {
                    msgid: "m-img",
                    chatid: "g-1",
                    from: { userid: "u1" },
                    image: { url: "https://example.test/i", aeskey: "key-1" },
                },
            });
            const text = h.client.deliverText({
                body: {
                    msgid: "m-cap",
                    chatid: "g-1",
                    chattype: "group",
                    from: { userid: "u2" },
                    text: { content: "hello" },
                },
            });
            await Promise.all([image, text]);
            // Each sender has its own batch, so the two prompts are ordered by
            // when each batch settles — not by arrival.
            assert.deepEqual(h.submitted.map((m) => m.peerId).sort(), ["u1", "u2"]);
            await handle.close();
        });

        it("downloads an inbound image and submits it as media", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.downloadResult = { buffer: Buffer.from("PNGBYTES") };
            await h.client.deliverImage({
                body: {
                    msgid: "m-img",
                    chatid: "g-1",
                    from: { userid: "u1" },
                    image: { url: "https://example.test/i", aeskey: "key-1" },
                },
            });
            await new Promise((r) => setImmediate(r));
            assert.equal(h.submitted.length, 1);
            const msg = h.submitted[0];
            assert.equal(msg.kind, "media");
            assert.equal(msg.text, "");
            assert.equal(msg.media?.length, 1);
            assert.equal(msg.media?.[0].kind, "image");
            // The platform's download key travels with the request: only the
            // SDK can decrypt the body.
            assert.deepEqual(h.client.lastDownload, {
                url: "https://example.test/i",
                aesKey: "key-1",
            });
            await handle.close();
        });

        it("keeps the platform file name when it submits a file", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.downloadResult = { buffer: Buffer.from("%PDF-1.7"), filename: "report.pdf" };
            await h.client.deliverFile({
                body: {
                    msgid: "m-file",
                    chatid: "g-1",
                    from: { userid: "u1" },
                    file: { url: "https://example.test/f" },
                },
            });
            await new Promise((r) => setImmediate(r));
            assert.equal(h.submitted.length, 1);
            const media = h.submitted[0].media?.[0];
            assert.equal(media?.kind, "file");
            // The name is the only thing the model ever sees of the file.
            assert.equal(media?.name, "report.pdf");
            assert.equal(media?.source.kind, "base64");
            await handle.close();
        });

        it("drops an inbound image whose download fails", async () => {
            const warns: string[] = [];
            const logger: Logger = {
                debug: () => {},
                info: () => {},
                warn: (msg) => warns.push(msg),
                error: () => {},
                child: () => logger,
            };
            const h = harness({ credentials: { botId: "b", secret: "s" }, logger });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.downloadFile = async () => {
                throw new Error("expired");
            };
            await h.client.deliverImage({
                body: {
                    msgid: "m-img",
                    from: { userid: "u1" },
                    image: { url: "https://example.test/i" },
                },
            });
            await new Promise((r) => setImmediate(r));
            assert.equal(h.submitted.length, 0);
            assert.match(warns.join("\n"), /m-img/);
            assert.equal(warns.join("\n").includes("u1"), false);
            await handle.close();
        });

        it("ignores inbound frames missing required fields without throwing", async () => {
            const h = harness({
                credentials: { botId: "b", secret: "s" },
                route: { channelId: "wecom", peerId: "u1", chatId: "u1" },
            });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await h.client.deliverText({ body: { from: { userid: "" }, text: { content: "x" } } });
            await h.client.deliverText({ body: { msgid: "ok", from: { userid: "u1" } } });
            await new Promise((r) => setImmediate(r));
            assert.equal(h.submitted.length, 0);
            await handle.close();
        });

        it("pushes replies via sendMessage to the route chatId using markdown chunks", async () => {
            const h = harness({
                credentials: { botId: "b", secret: "s" },
                route: { channelId: "wecom", peerId: "u2", chatId: "g-77" },
            });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await handle.push(replyFrame("the answer"));
            assert.equal(h.client.sent.length, 1);
            assert.equal(h.client.sent[0].chatid, "g-77");
            assert.equal(h.client.sent[0].body.msgtype, "markdown");
            assert.equal(h.client.sent[0].body.markdown?.content, "the answer");
            await handle.close();
        });

        it("drops push frames when the session cannot be resolved to a route", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await handle.push(replyFrame("the answer"));
            assert.equal(h.client.sent.length, 0);
            await handle.close();
        });

        it("drops push frames before any bind, when no client exists", async () => {
            const h = harness({ route: { channelId: "wecom", peerId: "u1", chatId: "u1" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await handle.push(replyFrame("the answer"));
            assert.equal(h.clients.length, 0);
            await handle.close();
        });

        // Also the persistence contract: login must write the credentials it just
        // connected with, not just hand them to the client.
        it("login builds a fresh client carrying the new credentials rather than reusing the old one", async () => {
            // Regression: WSClient copies botId/secret in its constructor, so a
            // reconnect on the same instance re-sends the credentials it was born
            // with — a first bind would authenticate with the empty pair.
            const h = harness();
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            assert.equal(h.clients.length, 0);

            await handle.login(false, { botId: "B1", secret: "S1" });
            assert.equal(h.clients.length, 1);
            assert.equal(h.broker.status("wecom").state, "connecting");
            assert.deepEqual(h.store.get("credentials"), { botId: "B1", secret: "S1" });
            assert.deepEqual(
                { botId: h.clients[0].opts.botId, secret: h.clients[0].opts.secret },
                { botId: "B1", secret: "S1" },
            );

            await handle.login(false, { botId: "B2", secret: "S2" });
            assert.equal(h.clients.length, 2);
            assert.deepEqual(h.store.get("credentials"), { botId: "B2", secret: "S2" });
            assert.deepEqual(
                { botId: h.clients[1].opts.botId, secret: h.clients[1].opts.secret },
                { botId: "B2", secret: "S2" },
            );
            // Old client torn down, new one connected exactly once.
            assert.equal(h.clients[0].disconnectCalls, 1);
            assert.equal(h.clients[1].connectCalls, 1);

            h.clients[1].markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");
            await handle.close();
        });

        it("rebinding severs the superseded client's handlers so its teardown cannot clobber the new state", async () => {
            const h = harness({ credentials: { botId: "b1", secret: "s1" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.markAuthenticated();
            const old = h.clients[0];

            await handle.login(false, { botId: "b2", secret: "s2" });
            h.clients[1].markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");

            // closeClient() disconnects the old client AND severs its handlers.
            // (The stale() guard in each handler is the second line of defence; a
            // discard that forgot to removeAllListeners would still be neutralised
            // by it. Here we assert the first line: nothing is left attached.)
            assert.equal(old.disconnectCalls, 1);
            assert.equal(old.listenerCount("authenticated"), 0);
            assert.equal(old.listenerCount("error"), 0);
            assert.equal(old.listenerCount("disconnected"), 0);
            assert.equal(old.listenerCount("message.text"), 0);
            // A late inbound frame on the old client is dropped — no handler is
            // attached to route it, and the stale guard would refuse it anyway.
            old.deliverText({
                body: { msgid: "m-stale", from: { userid: "u1" }, text: { content: "late" } },
            });
            await new Promise((r) => setImmediate(r));
            assert.equal(h.submitted.length, 0);
            await handle.close();
        });

        it("login throws when called with no creds and no stored creds", async () => {
            const h = harness();
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await assert.rejects(() => handle.login(false), /requires botId and secret/);
            await handle.close();
        });

        it("retryWithStoredCreds rebuilds the client with the on-disk credentials", async () => {
            // Once the SDK stops retrying (auth budget exhausted, kicked by a
            // newer connection), the cached WSClient refuses another attempt.
            // retryWithStoredCreds is the manual escape hatch: it rebuilds
            // from scratch using the same botId/secret so the SDK's counter
            // starts over.
            const h = harness({ credentials: { botId: "b0", secret: "s0" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");

            await handle.retryWithStoredCreds();
            assert.equal(h.clients.length, 2);
            assert.deepEqual(
                { botId: h.clients[1].opts.botId, secret: h.clients[1].opts.secret },
                { botId: "b0", secret: "s0" },
            );
            assert.equal(h.clients[1].connectCalls, 1);
            h.clients[1].markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");
            await handle.close();
        });

        it("retryWithStoredCreds throws when no credentials are on disk", async () => {
            const h = harness();
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            await assert.rejects(() => handle.retryWithStoredCreds(), /bind first/);
            await handle.close();
        });

        it("logout disconnects and clears the channel store", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            assert.equal(h.store.has("credentials"), true);
            await handle.logout();
            assert.equal(h.client.disconnectCalls >= 1, true);
            assert.equal(h.store.has("credentials"), false);
            // Without an explicit unbound transition, the broker keeps the prior
            // state (connected/error) and the UI offers Rebind where Bind is correct.
            assert.equal(h.broker.status("wecom").state, "unbound");
            await handle.close();
        });

        it("transient SDK disconnect (not intentional) reports error then recovers on authenticated", async () => {
            const h = harness({ credentials: { botId: "b", secret: "s" } });
            const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
            h.client.markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");
            h.client.markDisconnected("network blip");
            assert.equal(h.broker.status("wecom").state, "error");
            h.client.markAuthenticated();
            assert.equal(h.broker.status("wecom").state, "connected");
            await handle.close();
        });
    });
});

describe("integration", () => {
    useTempTacoHome("im-integration");
    stubModelFetch();

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
});
