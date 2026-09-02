import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { ChannelsBindCreds, ServerPush } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import {
    WeComChannel,
    type WeComChannelHandle,
    type WeComClientFactoryOptions,
    type WeComClientLike,
    type WeComTextFrameLike,
} from "../../src/channels/builtin/wecomChannel.ts";
import { ChannelBindBroker } from "../../src/channels/channelBindBroker.ts";
import type { ChannelContext, ChannelInboundMessage, Logger } from "../../src/channels/types.ts";

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
    /** Test helper — emit a typed message.text frame. */
    deliverText(frame: WeComTextFrameLike): void {
        this.emit("message.text", frame);
    }
    /** Test helper — emit the SDK's authenticated success. */
    markAuthenticated(): void {
        this.emit("authenticated");
    }
    markDisconnected(reason: string): void {
        this.emit("disconnected", reason);
    }
    markError(err: Error): void {
        this.emit("error", err);
    }
}

interface Harness {
    channel: WeComChannel;
    ctx: ChannelContext;
    broker: ChannelBindBroker;
    client: FakeClient;
    submitted: ChannelInboundMessage[];
    store: Map<string, unknown>;
}

function harness(
    opts: {
        credentials?: ChannelsBindCreds;
        route?: { channelId: string; peerId: string; chatId: string };
    } = {},
): Harness {
    const client = new FakeClient();
    const broker = new ChannelBindBroker();
    const submitted: ChannelInboundMessage[] = [];
    const store = new Map<string, unknown>(
        opts.credentials ? Object.entries({ credentials: opts.credentials }) : [],
    );
    const channel = new WeComChannel({
        broker,
        resolveRoute: () => opts.route,
        createClient: (_o: WeComClientFactoryOptions) => client,
    });
    const ctx: ChannelContext = {
        channelId: "wecom",
        logger: silentLogger(),
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
    return { channel, ctx, broker, client, submitted, store };
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
    it("starts unbound when no stored credentials", async () => {
        const h = harness();
        await h.channel.start(h.ctx);
        assert.equal(h.broker.status("wecom").state, "unbound");
        assert.equal(h.client.connectCalls, 0);
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        await handle.close();
    });

    it("auto-connects when stored credentials are present and reports connected on authenticate", async () => {
        const h = harness({ credentials: { botId: "b1", secret: "s1" } });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        assert.equal(h.broker.status("wecom").state, "connecting");
        assert.equal(h.client.connectCalls, 1);
        h.client.markAuthenticated();
        assert.equal(h.broker.status("wecom").state, "connected");
        await handle.close();
    });

    it("routes an inbound text message into the conversation router with msgid as platformMessageId", async () => {
        const h = harness({
            route: { channelId: "wecom", peerId: "u1", chatId: "u1" },
        });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        h.client.deliverText({
            body: {
                msgid: "m-123",
                chattype: "single",
                from: { userid: "u1" },
                text: { content: "hello" },
            },
        });
        // Wait one microtask for the void promise.
        await new Promise((r) => setImmediate(r));
        assert.equal(h.submitted.length, 1);
        assert.deepEqual(h.submitted[0], {
            platformMessageId: "m-123",
            channelId: "wecom",
            peerId: "u1",
            chatId: "u1",
            kind: "text",
            text: "hello",
        });
        await handle.close();
    });

    it("falls back chatId to the peer userid for 1:1 chats when chatid is empty", async () => {
        const h = harness({ route: { channelId: "wecom", peerId: "u1", chatId: "u1" } });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        h.client.deliverText({
            body: {
                msgid: "m-empty",
                chatid: "",
                chattype: "single",
                from: { userid: "u1" },
                text: { content: "hi" },
            },
        });
        await new Promise((r) => setImmediate(r));
        assert.equal(h.submitted.length, 1);
        assert.equal(h.submitted[0].chatId, "u1");
        await handle.close();
    });

    it("uses the SDK-provided chatid for group chats", async () => {
        const h = harness({
            route: { channelId: "wecom", peerId: "u2", chatId: "g-77" },
        });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        h.client.deliverText({
            body: {
                msgid: "m-grp",
                chatid: "g-77",
                chattype: "group",
                from: { userid: "u2" },
                text: { content: "team" },
            },
        });
        await new Promise((r) => setImmediate(r));
        assert.equal(h.submitted.length, 1);
        assert.equal(h.submitted[0].chatId, "g-77");
        await handle.close();
    });

    it("ignores inbound frames missing required fields without throwing", async () => {
        const h = harness({ route: { channelId: "wecom", peerId: "u1", chatId: "u1" } });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        h.client.deliverText({ body: { from: { userid: "" }, text: { content: "x" } } });
        h.client.deliverText({ body: { msgid: "ok", from: { userid: "u1" } } });
        await new Promise((r) => setImmediate(r));
        assert.equal(h.submitted.length, 0);
        await handle.close();
    });

    it("pushes replies via sendMessage to the route chatId using markdown chunks", async () => {
        const h = harness({
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
        const h = harness();
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        await handle.push(replyFrame("the answer"));
        assert.equal(h.client.sent.length, 0);
        await handle.close();
    });

    it("login persists credentials, transitions to connecting, and kicks connect", async () => {
        const h = harness();
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        await handle.login(false, { botId: "B", secret: "S" });
        assert.deepEqual(h.store.get("credentials"), { botId: "B", secret: "S" });
        assert.equal(h.broker.status("wecom").state, "connecting");
        assert.equal(h.client.connectCalls, 1);
        h.client.markAuthenticated();
        assert.equal(h.broker.status("wecom").state, "connected");
        await handle.close();
    });

    it("login throws when called with no creds and no stored creds", async () => {
        const h = harness();
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        await assert.rejects(() => handle.login(false), /requires botId and secret/);
        await handle.close();
    });

    it("logout disconnects and clears the channel store", async () => {
        const h = harness({ credentials: { botId: "b", secret: "s" } });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        assert.equal(h.store.has("credentials"), true);
        await handle.logout();
        assert.equal(h.client.disconnectCalls >= 1, true);
        assert.equal(h.store.has("credentials"), false);
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
