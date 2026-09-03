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

    it("routes an inbound text message into the conversation router with msgid as platformMessageId", async () => {
        const h = harness({
            credentials: { botId: "b", secret: "s" },
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
        const h = harness({
            credentials: { botId: "b", secret: "s" },
            route: { channelId: "wecom", peerId: "u1", chatId: "u1" },
        });
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
            credentials: { botId: "b", secret: "s" },
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
        const h = harness({
            credentials: { botId: "b", secret: "s" },
            route: { channelId: "wecom", peerId: "u1", chatId: "u1" },
        });
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        h.client.deliverText({ body: { from: { userid: "" }, text: { content: "x" } } });
        h.client.deliverText({ body: { msgid: "ok", from: { userid: "u1" } } });
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

    it("login builds a fresh client carrying the new credentials rather than reusing the old one", async () => {
        // Regression: WSClient copies botId/secret in its constructor, so a
        // reconnect on the same instance re-sends the credentials it was born
        // with — a first bind would authenticate with the empty pair.
        const h = harness();
        const handle = (await h.channel.start(h.ctx)) as WeComChannelHandle;
        assert.equal(h.clients.length, 0);

        await handle.login(false, { botId: "B1", secret: "S1" });
        assert.equal(h.clients.length, 1);
        assert.deepEqual(
            { botId: h.clients[0].opts.botId, secret: h.clients[0].opts.secret },
            { botId: "B1", secret: "S1" },
        );

        await handle.login(false, { botId: "B2", secret: "S2" });
        assert.equal(h.clients.length, 2);
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
        // After the SDK's reconnect budget is exhausted, a passive UI is
        // stuck on error because the cached WSClient refuses to retry.
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
