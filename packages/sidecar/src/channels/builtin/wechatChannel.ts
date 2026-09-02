/**
 * WeChat channel over the official iLink Bot API (`@wechatbot/wechatbot`).
 *
 * start() returns synchronously: ChannelRegistry.loadAndStart awaits it before
 * the hello frame is sent, so awaiting a QR scan here would hang sidecar
 * startup and the client could never connect. Login runs in the background —
 * with stored credentials it reconnects on its own; without them the channel
 * idles in `unbound` until channels.bind arrives.
 */

import type { ServerPush } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import { WeChatBot } from "@wechatbot/wechatbot";
import { sidecarVersion } from "../../runtime/runtimeResources.ts";
import type { ChannelBindBroker } from "../channelBindBroker.ts";
import { CREDENTIALS_KEY } from "../channelConfigStore.ts";
import type {
    Channel,
    ChannelContext,
    ChannelHandle,
    ChannelRouteResolver,
    Logger,
} from "../types.ts";
import { chunkText, extractReplyText, interruptNoticeText } from "./channelReply.ts";
import { wechatChannelManifest } from "./wechatManifest.ts";

/** iLink caps a text message well below this; chunking keeps a safety margin. */
const WECHAT_MAX_MESSAGE_LENGTH = wechatChannelManifest.capabilities.maxMessageLength;

export interface WeChatChannelOptions {
    broker: ChannelBindBroker;
    /** Resolves the IM route triple for a session; wechat only needs the
     *  peerId (single-chat send), so it takes `.peerId`. */
    resolveRoute: ChannelRouteResolver;
    /** Injectable for tests; defaults to the real SDK client. */
    createBot?: (opts: WeChatBotFactoryOptions) => WeChatBotLike;
    /** Optional: returns the platform user IDs routed through this channel, so
     *  a workspace-dimensioned frame (no session) can broadcast to all peers.
     *  Receives the channelId so the resolver need not close over the context. */
    listPeers?: (channelId: string) => string[];
}

/** The slice of the SDK surface this channel uses. */
export interface WeChatBotLike {
    login(options?: { force?: boolean; callbacks?: SdkLoginCallbacks }): Promise<unknown>;
    start(): Promise<void>;
    stop(): void;
    send(userId: string, content: string): Promise<void>;
    onMessage(handler: (msg: IncomingLike) => void | Promise<void>): unknown;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    readonly isRunning: boolean;
}

/**
 * Every iLink message delivery on the wire carries `message_id` and
 * `create_time_ms` — server-assigned id + server epoch milliseconds. These
 * are the stable identity fields the platformMessageId fallback chain in
 * `bot.onMessage` dedups on; without them a retried long-poll delivery
 * gets a fresh `Date.now()` and `session.prompt` thinks it's a new prompt.
 *
 * Tightening them to required (instead of optional in `IncomingLike`) means
 * the TypeScript compiler flags an SDK upgrade that drops the field —
 * exactly the regression we want to catch.
 */
export interface IncomingBaseLike {
    userId: string;
    text: string;
    raw: {
        message_id: number;
        create_time_ms: number;
    };
}

/**
 * Group / P2P / chat routing. `raw.group_id` is the chat id (iLink sends
 * `""` for 1:1 chats — the channel normalises that to `msg.userId`).
 */
export interface IncomingGroupLike extends IncomingBaseLike {
    raw: IncomingBaseLike["raw"] & { group_id?: string };
}

/**
 * Long-poll replay / cursor mechanics.
 *  - `raw.seq` is the per-peer monotonic cursor sequence (always present
 *    on every delivery; absent only on the very first one — the SDK may
 *    or may not include it, depending on the server's first-delivery flag).
 *  - `raw.client_id` is the cursor id the next long-poll should resume
 *    from. Set only on replayed deliveries.
 */
export interface IncomingReplayLike extends IncomingBaseLike {
    raw: IncomingBaseLike["raw"] & { seq?: number; client_id?: string };
}

/**
 * Composite shape every iLink delivery matches. Tests that exercise a
 * single path may use the narrower `IncomingGroupLike` /
 * `IncomingReplayLike` interfaces.
 */
export type IncomingLike = IncomingGroupLike & IncomingReplayLike;

/**
 * QR-flow callbacks. Must be passed to `login()`, NOT to the constructor:
 * despite what the SDK README shows, `client.login()` forwards only its own
 * `options.callbacks` and silently ignores constructor `loginCallbacks`, so
 * configuring them at construction time means the QR URL is never delivered.
 */
export interface SdkLoginCallbacks {
    onQrUrl: (url: string) => void;
    onScanned: () => void;
    onExpired: () => void;
    onVerifyCode: (isRetry: boolean) => Promise<string>;
}

export interface WeChatBotFactoryOptions {
    storage: SdkStorage;
    logger: SdkLogger;
}

/** The SDK's pluggable Storage contract. */
interface SdkStorage {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    clear(): Promise<void>;
}

interface SdkLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    child(context: string): SdkLogger;
}

export class WeChatChannel implements Channel {
    readonly manifest = wechatChannelManifest;

    constructor(private readonly options: WeChatChannelOptions) {}

    async start(ctx: ChannelContext): Promise<ChannelHandle> {
        const { broker, resolveRoute, listPeers } = this.options;
        const log = ctx.logger;
        const storage = createStorageAdapter(ctx);

        const bot = (this.options.createBot ?? defaultCreateBot)({
            storage,
            logger: createLoggerAdapter(log),
        });

        const callbacks: SdkLoginCallbacks = {
            onQrUrl: (url) => broker.requestScan(ctx.channelId, url),
            onScanned: () => broker.setState(ctx.channelId, "scanned"),
            onExpired: () => broker.setState(ctx.channelId, "expired"),
            onVerifyCode: (isRetry) => broker.requestVerifyCode(ctx.channelId, isRetry),
        };

        bot.on("login", () => broker.setState(ctx.channelId, "connected"));
        bot.on("poll:start", () => broker.setState(ctx.channelId, "connected"));
        bot.on("session:expired", () => broker.setState(ctx.channelId, "unbound"));
        bot.on("session:restored", () => broker.setState(ctx.channelId, "connected"));
        bot.on("error", (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            log.error(`bot error: ${message}`);
            broker.setState(ctx.channelId, "error", { message });
        });

        bot.onMessage(async (msg) => {
            // chatId groups a conversation: a group shares one session, a 1:1
            // chat falls back to the peer's own id.
            //
            // iLink sends group_id as an EMPTY STRING for 1:1 chats, not
            // undefined, so `??` would let "" through — and an empty chatId
            // produces a workspace key that parseImCwd cannot parse, which
            // silently breaks the reply path (no peer resolves for the session).
            const peerId = msg.userId;
            const chatId = msg.raw.group_id?.trim() || msg.userId;
            // platformMessageId must be stable across redeliveries (long-poll cursor
            // rewinds, iLink retries) so session.prompt's commandId dedup
            // catches them. `peerId-chatId` alone would also dedup two distinct
            // messages from the same peer; we tag on a monotonic upstream
            // identifier — message_id → client_id → seq → create_time_ms —
            // each stable for one delivery. The fallback chain is a safety
            // net for an SDK upgrade that drops `message_id`; the type
            // system forbids it today, the chain keeps us alive tomorrow.
            const raw = msg.raw;
            const platformMessageId = String(
                raw.message_id ??
                    raw.client_id ??
                    raw.seq ??
                    `${peerId}-${chatId}-${raw.create_time_ms}`,
            );
            try {
                const { sessionId } = await ctx.ingress.submit({
                    platformMessageId,
                    channelId: ctx.channelId,
                    peerId,
                    chatId,
                    kind: "text",
                    text: msg.text,
                });
                // peerId/chatId are platform user identifiers and logs persist
                // to disk — only sessionId is safe to record.
                log.child({ sid: sessionId }).info("inbound message routed");
            } catch (e) {
                log.error(`inbound submit failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        });

        // Only auto-start when credentials already exist; a fresh install must
        // wait for an explicit bind rather than printing a QR nobody asked for.
        if (await storage.has(CREDENTIALS_KEY)) {
            broker.setState(ctx.channelId, "connecting");
            void bot
                // Credentials exist, so this resolves without a QR; callbacks
                // are still passed in case they turn out to be stale.
                .login({ callbacks })
                .then(() => bot.start())
                .catch((e: unknown) => {
                    const message = e instanceof Error ? e.message : String(e);
                    log.error(`auto-login failed: ${message}`);
                    broker.setState(ctx.channelId, "error", { message });
                });
        } else {
            broker.setState(ctx.channelId, "unbound");
        }

        return new WeChatChannelHandle(
            bot,
            ctx,
            resolveRoute,
            broker,
            callbacks,
            listPeers ? () => listPeers(ctx.channelId) : undefined,
        );
    }
}

class WeChatChannelHandle implements ChannelHandle {
    constructor(
        private readonly bot: WeChatBotLike,
        private readonly ctx: ChannelContext,
        private readonly resolveRoute: ChannelRouteResolver,
        private readonly broker: ChannelBindBroker,
        private readonly callbacks: SdkLoginCallbacks,
        readonly listPeers?: () => string[],
    ) {}

    async push(frame: ServerPush): Promise<void> {
        // A workspace-dimensioned interrupt notice (no session) can't be routed
        // through resolvePeer — broadcast it to every peer on the channel.
        if (frame.method === PushMethods.ImWorkspacesInvalidated) {
            const notice = interruptNoticeText();
            for (const userId of this.listPeers?.() ?? []) {
                for (const chunk of chunkText(notice, WECHAT_MAX_MESSAGE_LENGTH)) {
                    await this.bot.send(userId, chunk);
                }
            }
            return;
        }
        const text = extractReplyText(frame);
        if (!text) return;
        const sessionId = frame.session;
        if (!sessionId) return;
        const route = this.resolveRoute(sessionId);
        if (!route) {
            this.ctx.logger.child({ sid: sessionId }).warn("no peer for session, reply dropped");
            return;
        }
        const userId = route.peerId;
        for (const chunk of chunkText(text, WECHAT_MAX_MESSAGE_LENGTH)) {
            await this.bot.send(userId, chunk);
        }
    }

    /** Runs the QR flow, then enters the long-poll loop. Callers must not await
     *  this in a request path: a human has to scan the code first. */
    async login(force?: boolean): Promise<void> {
        this.broker.setState(this.ctx.channelId, "connecting");
        await this.bot.login({ force, callbacks: this.callbacks });
        if (!this.bot.isRunning) await this.bot.start();
    }

    async logout(): Promise<void> {
        this.bot.stop();
        // Wipe the whole store, not just credentials: the SDK persists cursor /
        // context_tokens / typing_tickets here too. Leaving context_tokens would
        // keep a roster of every peer who ever messaged the bot, plus per-peer
        // send authorization.
        await this.ctx.config.clear();
    }

    async close(): Promise<void> {
        this.broker.cancel(this.ctx.channelId, "channel closing");
        this.bot.stop();
    }
}

/** Bridges the SDK's async Storage onto the synchronous ChannelConfigStore. */
function createStorageAdapter(ctx: ChannelContext): SdkStorage {
    return {
        get: async <T>(key: string) => ctx.config.get<T>(key),
        set: async <T>(key: string, value: T) => ctx.config.set(key, value),
        delete: async (key: string) => ctx.config.set(key, undefined),
        has: async (key: string) => ctx.config.get(key) !== undefined,
        // SDK contract: clear() wipes everything, not just credentials.
        clear: async () => ctx.config.clear(),
    };
}

/** The SDK's child(context) takes a string; ours takes fields. */
function createLoggerAdapter(log: Logger): SdkLogger {
    const wrap = (l: Logger): SdkLogger => ({
        // debug stays debug — the SDK's debug lines embed raw peer userIds
        // ("Sent text to ..."), and info is the default threshold that lands
        // in taco-desktop.log. Promoting them to info would leak PII to disk
        // for every reply. See LogFields doc (logger.ts).
        debug: (m) => l.debug(m),
        info: (m) => l.info(m),
        warn: (m) => l.warn(m),
        error: (m) => l.error(m),
        child: (context) => wrap(l.child({ scope: context })),
    });
    return wrap(log);
}

function defaultCreateBot(opts: WeChatBotFactoryOptions): WeChatBotLike {
    // No loginCallbacks here on purpose — see SdkLoginCallbacks.
    //
    // botAgent identifies the driving app to the iLink API (sent as
    // base_info.bot_agent on every request). We stamp "taco/<version>" so
    // iLink operators can distinguish taco traffic from raw SDK users
    // for capacity / audit purposes — same convention as the sidecar's
    // own user-agent header in attachedSession.ts.
    return new WeChatBot({
        storage: opts.storage,
        logger: opts.logger,
        botAgent: `taco/${sidecarVersion()}`,
    }) as unknown as WeChatBotLike;
}
