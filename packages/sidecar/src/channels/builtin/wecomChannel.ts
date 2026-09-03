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
 *
 * Every (re)connect builds a fresh client: `WSClient` copies botId/secret into
 * its connection manager once, in the constructor, so calling connect() again
 * on an existing instance re-sends the credentials it was born with.
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
    /** Present on EventEmitter-backed clients (the SDK's WSClient, test
     *  fakes). Lets closeClient() drop the previous client's handlers so the
     *  discarded instance — and the closure its handlers capture — is not
     *  held reachable by SDK internals across rebinds. */
    removeAllListeners?(): void;
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
        const handle = new WeComChannelHandle(
            ctx,
            broker,
            resolveRoute,
            this.options.createClient ?? defaultCreateClient,
        );

        // Auto-connect when credentials are already on disk (channel was
        // bound on a previous run); otherwise wait for an explicit bind that
        // carries botId + secret over channels.bind.
        if (creds.botId && creds.secret) {
            handle.reconnect(creds);
        } else {
            broker.setState(ctx.channelId, "unbound");
        }
        return handle;
    }
}

export class WeComChannelHandle implements ChannelHandle {
    /** Undefined until the first `reconnect` — a channel with no stored
     *  credentials holds no client at all, so a push before bind is dropped
     *  instead of being sent over an unauthenticated socket. */
    private client?: WeComClientLike;
    /** Set while a disconnect() we initiated is in flight, so the SDK's
     *  `disconnected` event doesn't surface as a broker error. Cleared by the
     *  next reconnect, since each reconnect builds a fresh client. */
    private intentionalClose = false;

    constructor(
        private readonly ctx: ChannelContext,
        private readonly broker: ChannelBindBroker,
        private readonly resolveRoute: ChannelRouteResolver,
        private readonly createClient: (opts: WeComClientFactoryOptions) => WeComClientLike,
    ) {}

    async push(frame: ServerPush): Promise<void> {
        const text = extractReplyText(frame);
        if (!text) return;
        const sessionId = frame.session;
        if (!sessionId) return;
        const client = this.client;
        if (!client) {
            this.ctx.logger.child({ sid: sessionId }).warn("channel not connected, reply dropped");
            return;
        }
        const route = this.resolveRoute(sessionId);
        if (!route) {
            this.ctx.logger.child({ sid: sessionId }).warn("no peer for session, reply dropped");
            return;
        }
        for (const chunk of chunkText(text, WECOM_MAX_MESSAGE_LENGTH)) {
            await client.sendMessage(route.chatId, {
                msgtype: "markdown",
                markdown: { content: chunk },
            });
        }
    }

    /** Tears down any live client and builds a new one bound to `creds`, then
     *  kicks connect. Synchronous: auth progress arrives out-of-band through
     *  the SDK's `authenticated` / `disconnected` events.
     *
     *  Not part of the ChannelHandle contract — callers outside this module
     *  reach it only as `handle.reconnect` after casting to the concrete
     *  class (WeComChannel.start uses it to auto-connect on load). The public
     *  entry points are login() (with fresh creds) and
     *  retryWithStoredCreds() (with whatever is on disk). */
    reconnect(creds: ChannelsBindCreds): void {
        this.closeClient();
        const client = this.createClient({
            botId: creds.botId ?? "",
            secret: creds.secret ?? "",
            logger: createLoggerAdapter(this.ctx.logger),
        });
        this.client = client;
        this.intentionalClose = false;
        this.attachHandlers(client);

        this.broker.setState(this.ctx.channelId, "connecting");
        try {
            client.connect();
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.broker.setState(this.ctx.channelId, "error", { message });
        }
    }

    private attachHandlers(client: WeComClientLike): void {
        const { ctx, broker } = this;
        // Every handler exits when `client` is no longer the current one: a
        // superseded client can still emit (its socket teardown is async), and
        // its late `disconnected` must not clobber the new client's state.
        const stale = () => this.client !== client;

        client.on("authenticated", () => {
            if (stale()) return;
            broker.setState(ctx.channelId, "connected");
        });
        client.on("error", (...args: unknown[]) => {
            if (stale()) return;
            const message = args
                .map((a) => (a instanceof Error ? a.message : String(a)))
                .join("; ");
            broker.setState(ctx.channelId, "error", { message });
        });
        client.on("disconnected", (...args: unknown[]) => {
            if (stale() || this.intentionalClose) return;
            const reason = args.map((a) => String(a)).join("; ");
            broker.setState(ctx.channelId, "error", { message: `disconnected: ${reason}` });
        });

        client.on("message.text", (...args: unknown[]) => {
            if (stale()) return;
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
    }

    /** Drops the current client, marking the disconnect intentional so its
     *  teardown events are ignored. */
    private closeClient(): void {
        const client = this.client;
        if (!client) return;
        this.intentionalClose = true;
        this.client = undefined;
        try {
            client.disconnect();
        } catch {
            // Best-effort: the instance is being discarded either way.
        }
        // Drop the previous client's listeners too. Not strictly required for
        // GC (an unreferenced instance is collected whole, cycles and all), but
        // a defensive guarantee that a rebind cycle never leaves stale handlers
        // reachable from SDK internals. The stale() guard already neutralises
        // any late emission; this severs the reference outright.
        client.removeAllListeners?.();
    }

    /** Persists `creds` and reconnects the WS with them. Resolves once
     *  connect() is kicked — auth progress arrives out-of-band via
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
        this.reconnect(next);
    }

    async logout(): Promise<void> {
        this.closeClient();
        // Wipe the whole store, not just credentials: the store may carry
        // future per-channel runtime state. clear() mirrors wechat semantics
        // and re-seeds from the (empty) taco.json config block on next start.
        await this.ctx.config.clear();
        // Mirror wechat's server-side `reset`: without it, the broker keeps
        // showing the pre-unbind state ("connected", "error") and the UI
        // offers Rebind where Bind is correct.
        this.broker.setState(this.ctx.channelId, "unbound");
    }

    /** Reconnect using whatever credentials are already on disk. After the
     *  SDK's reconnect budget is exhausted (10 attempts), no further
     *  automatic retries happen and a passive UI is stuck on error. This
     *  rebuilds the client from scratch — the cached WSClient can no longer
     *  be coaxed into another attempt — using the same botId/secret, then
     *  starts the SDK's reconnect cycle over. */
    async retryWithStoredCreds(): Promise<void> {
        const stored = this.ctx.config.get<ChannelsBindCreds>(CREDENTIALS_KEY);
        if (!stored?.botId || !stored?.secret) {
            throw new Error("wecom retry requires stored botId and secret — bind first");
        }
        this.reconnect(stored);
    }

    async close(): Promise<void> {
        this.broker.cancel(this.ctx.channelId, "channel closing");
        this.closeClient();
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
 *  is the threshold that lands in taco-desktop.log).
 *
 *  Trailing args carry the diagnostic payload — the SDK logs the offending
 *  frame and the underlying error message that way ("Received unknown frame
 *  (ignored):", "Failed to send auth frame:"), so dropping them leaves a
 *  message that ends in a bare colon. They are folded into the single-arg
 *  message at warn/error only; a raw frame may embed peer identifiers, and
 *  `debug` is below the threshold that reaches disk.
 *
 *  debug/info deliberately do NOT fold. debug never reaches disk, so its
 *  payload is moot, and info's would reach the threshold — if the SDK ever
 *  starts passing peer data to info, folding it here would leak PII to
 *  taco-desktop.log. warn/error are the diagnostic surfaces, so they get the
 *  full message. */
function createLoggerAdapter(log: Logger): SdkLogger {
    const fold = (m: string, rest: unknown[]): string =>
        rest.length === 0 ? m : `${m} ${rest.map(formatSdkArg).join(" ")}`;
    const wrap = (l: Logger): SdkLogger => ({
        debug: (m, ..._rest) => l.debug(m),
        info: (m, ..._rest) => l.info(m),
        warn: (m, ...rest) => l.warn(fold(m, rest)),
        error: (m, ...rest) => l.error(fold(m, rest)),
    });
    return wrap(log);
}

/** Truncated so an oversized frame can't blow up a log line. */
const SDK_LOG_ARG_MAX = 512;

function formatSdkArg(a: unknown): string {
    const s = a instanceof Error ? a.message : String(a);
    return s.length > SDK_LOG_ARG_MAX ? `${s.slice(0, SDK_LOG_ARG_MAX)}…` : s;
}
