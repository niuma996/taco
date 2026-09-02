/**
 * WeCom (企业微信) aibot channel over the official Node SDK.
 *
 * The SDK connects via WebSocket long-poll to `wss://openws.work.weixin.qq.com`,
 * auto-authenticates with botId + secret, and emits typed events (`message.text`,
 * `authenticated`, `disconnected`, …). The channel does NOT use the QR / verify
 * code flow — admin-issued static credentials come in via channels.bind and are
 * persisted to the channel's `ChannelConfigStore` under the shared
 * CREDENTIALS_KEY so `hasStoredCredentials` (and therefore the Bind-vs-Rebind
 * card on the desktop) reads them consistently with wechat.
 *
 * start() returns synchronously (ChannelRegistry.loadAndStart awaits it before
 * sending the hello frame; an async auth wait here would block startup). When
 * stored credentials exist we kick connect in the background and let the SDK
 * events drive the bind broker through connecting → connected; without
 * credentials the broker sits in `unbound` until a bind carries botId+secret.
 */

import type { ChannelsBindCreds, ServerPush } from "@taco-ai/protocol";
import type { Logger as SdkLogger } from "@wecom/aibot-node-sdk";
import { WSClient } from "@wecom/aibot-node-sdk";
import type { ChannelBindBroker } from "../channelBindBroker.ts";
import { CREDENTIALS_KEY } from "../channelConfigStore.ts";
import type {
    Channel,
    ChannelContext,
    ChannelHandle,
    ChannelRouteResolver,
    Logger,
} from "../types.ts";
import { chunkText, extractReplyText } from "./channelReply.ts";
import { wecomChannelManifest } from "./wecomManifest.ts";

const WECOM_MAX_MESSAGE_LENGTH = wecomChannelManifest.capabilities.maxMessageLength;

/** Structural slice of `WSClient` this channel uses. The default factory
 *  casts the real SDK class to this; tests inject a FakeClient that
 *  implements it (extends EventEmitter). */
export interface WeComClientLike {
    connect(): unknown;
    disconnect(): void;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    sendMessage(
        chatid: string,
        body: { msgtype: string; [key: string]: unknown },
    ): Promise<unknown>;
}

/** Minimum aibot text frame this channel reads. Fields beyond what's consumed
 *  here are ignored; SDK upgrades that rename a wire field surface as a type
 *  error against this structural interface. */
export interface WeComTextFrameLike {
    body?: {
        msgid?: string;
        chatid?: string;
        chattype?: "single" | "group";
        from?: { userid?: string };
        text?: { content?: string };
    };
}

export interface WeComChannelOptions {
    broker: ChannelBindBroker;
    resolveRoute: ChannelRouteResolver;
    /** Injectable for tests; defaults to the real `WSClient` cast structurally. */
    createClient?: (opts: WeComClientFactoryOptions) => WeComClientLike;
}

export interface WeComClientFactoryOptions {
    botId: string;
    secret: string;
    logger: SdkLogger;
}

export class WeComChannel implements Channel {
    readonly manifest = wecomChannelManifest;

    constructor(private readonly options: WeComChannelOptions) {}

    async start(ctx: ChannelContext): Promise<ChannelHandle> {
        const { broker, resolveRoute } = this.options;
        const creds = ctx.config.get<ChannelsBindCreds>(CREDENTIALS_KEY) ?? {};
        const logger = createLoggerAdapter(ctx.logger);

        const client = (this.options.createClient ?? defaultCreateClient)({
            botId: creds.botId ?? "",
            secret: creds.secret ?? "",
            logger,
        });

        // Distinguishes a manual disconnect (logout / close) from the SDK's
        // automatic reconnect cycle. Without this, every transient network
        // blip would surface as a broker `error` until the SDK's next
        // authenticated event corrected it.
        let intentionalClose = false;

        client.on("authenticated", () => {
            intentionalClose = false;
            broker.setState(ctx.channelId, "connected");
        });
        client.on("error", (...args: unknown[]) => {
            const message = args
                .map((a) => (a instanceof Error ? a.message : String(a)))
                .join("; ");
            broker.setState(ctx.channelId, "error", { message });
        });
        client.on("disconnected", (...args: unknown[]) => {
            if (intentionalClose) return;
            const reason = args.map((a) => String(a)).join("; ");
            broker.setState(ctx.channelId, "error", { message: `disconnected: ${reason}` });
        });

        client.on("message.text", (...args: unknown[]) => {
            const frame = args[0] as WeComTextFrameLike | undefined;
            const body = frame?.body;
            if (!body || typeof body.msgid !== "string" || !body.text?.content) return;
            // chatId groups a conversation: a group shares one session, a 1:1
            // chat falls back to the peer's own id. aibot sends `chatid`
            // as "" for 1:1 — normalise that to the userid so
            // parseImCwd / makeImCwd always sees a non-empty third segment.
            const peerId = body.from?.userid;
            if (!peerId) return;
            const chatId = body.chatid?.trim() || peerId;
            // platformMessageId is the SDK's server-assigned `msgid`; it is
            // stable across long-poll retries (the SDK dedups on its own
            // cursor) so session.prompt's commandId idempotency catches
            // redeliveries. Falling back to the user/chat pair is a safety
            // net for an SDK upgrade that drops the field.
            const platformMessageId = body.msgid || `${peerId}-${chatId}-${Date.now()}`;
            void ctx.ingress
                .submit({
                    platformMessageId,
                    channelId: ctx.channelId,
                    peerId,
                    chatId,
                    kind: "text",
                    text: body.text.content,
                })
                .then(({ sessionId }) => {
                    // peerId / chatId are platform user identifiers and logs
                    // persist to disk — only sessionId is safe to record.
                    ctx.logger.child({ sid: sessionId }).info("inbound message routed");
                })
                .catch((e: unknown) => {
                    ctx.logger.error(
                        `inbound submit failed: ${e instanceof Error ? e.message : String(e)}`,
                    );
                });
        });

        // Auto-connect when credentials are already on disk (channel was
        // bound on a previous run); otherwise wait for an explicit bind that
        // carries botId + secret over channels.bind.
        if (creds.botId && creds.secret) {
            broker.setState(ctx.channelId, "connecting");
            intentionalClose = false;
            try {
                client.connect();
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                broker.setState(ctx.channelId, "error", { message });
            }
        } else {
            broker.setState(ctx.channelId, "unbound");
        }

        return new WeComChannelHandle(client, ctx, broker, resolveRoute, {
            markIntentional: () => {
                intentionalClose = true;
            },
        });
    }
}

export class WeComChannelHandle implements ChannelHandle {
    constructor(
        private readonly client: WeComClientLike,
        private readonly ctx: ChannelContext,
        private readonly broker: ChannelBindBroker,
        private readonly resolveRoute: ChannelRouteResolver,
        private readonly flags: { markIntentional: () => void },
    ) {}

    async push(frame: ServerPush): Promise<void> {
        const text = extractReplyText(frame);
        if (!text) return;
        const sessionId = frame.session;
        if (!sessionId) return;
        const route = this.resolveRoute(sessionId);
        if (!route) {
            this.ctx.logger.child({ sid: sessionId }).warn("no peer for session, reply dropped");
            return;
        }
        for (const chunk of chunkText(text, WECOM_MAX_MESSAGE_LENGTH)) {
            await this.client.sendMessage(route.chatId, {
                msgtype: "markdown",
                markdown: { content: chunk },
            });
        }
    }

    /** Persists `creds` and reconnects the WS. Resolves once connect() is
     *  kicked — auth progress arrives out-of-band via
     *  `authenticated`/`disconnected` events, matching the fire-and-forget
     *  contract of the bind RPC.
     *
     *  `force` mirrors wechat's "discard stored creds and re-run bind" — for
     *  wecom there is no QR re-run; force without fresh creds is rejected
     *  so callers cannot silently keep stale ones. */
    async login(force?: boolean, creds?: ChannelsBindCreds): Promise<void> {
        let next = creds;
        if (!next) {
            if (force) {
                throw new Error("wecom login with force requires fresh botId + secret in creds");
            }
            const stored = this.ctx.config.get<ChannelsBindCreds>(CREDENTIALS_KEY);
            if (!stored?.botId || !stored?.secret) {
                throw new Error(
                    "wecom login requires botId and secret — provide them via channels.bind creds or bind first",
                );
            }
            next = stored;
        }
        await this.ctx.config.set(CREDENTIALS_KEY, next);
        this.flags.markIntentional();
        try {
            this.client.disconnect();
        } catch {
            // Best-effort: even if disconnect raises, the next connect() will
            // reset the SDK's internal state.
        }
        this.broker.setState(this.ctx.channelId, "connecting");
        this.flags.markIntentional();
        try {
            this.client.connect();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.broker.setState(this.ctx.channelId, "error", { message });
            throw e;
        }
    }

    async logout(): Promise<void> {
        this.flags.markIntentional();
        try {
            this.client.disconnect();
        } catch {
            // Already disconnected; proceed to wipe credentials either way.
        }
        // Wipe the whole store, not just credentials: the store may carry
        // future per-channel runtime state. clear() mirrors wechat semantics
        // and re-seeds from the (empty) taco.json config block on next start.
        await this.ctx.config.clear();
    }

    async close(): Promise<void> {
        this.broker.cancel(this.ctx.channelId, "channel closing");
        this.flags.markIntentional();
        try {
            this.client.disconnect();
        } catch {
            // Channel is going away; swallow disconnect failures.
        }
    }
}

/** Cast the real SDK class to the structural seam. The WSClient signature
 *  (`sendMessage(chatid, SendMsgBody)`, `on(event: K, listener)`) is a strict
 *  superset of WeComClientLike — the cast narrows without losing calls. */
function defaultCreateClient(opts: WeComClientFactoryOptions): WeComClientLike {
    const client = new WSClient({
        botId: opts.botId,
        secret: opts.secret,
        logger: opts.logger,
    });
    return client as unknown as WeComClientLike;
}

/** Bridges the sidecar's single-arg Logger to the SDK's variadic Logger.
 *  Mirrors wechatChannel's createLoggerAdapter: keep `debug` at `debug` so
 *  SDK lines that embed peer identifiers never get promoted to `info` (which
 *  is the threshold that lands in taco-desktop.log). */
function createLoggerAdapter(log: Logger): SdkLogger {
    const wrap = (l: Logger): SdkLogger => ({
        debug: (m, ..._rest) => l.debug(m),
        info: (m, ..._rest) => l.info(m),
        warn: (m, ..._rest) => l.warn(m),
        error: (m, ..._rest) => l.error(m),
    });
    return wrap(log);
}
