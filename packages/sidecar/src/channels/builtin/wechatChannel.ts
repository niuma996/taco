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
import { mimeTypeFromName } from "../../attachments/mimeType.ts";
import { sidecarVersion } from "../../runtime/runtimeResources.ts";
import type { ChannelBindBroker } from "../channelBindBroker.ts";
import { CREDENTIALS_KEY } from "../channelConfigStore.ts";
import {
    DEFAULT_MERGE_MAX_WAIT_MS,
    DEFAULT_MERGE_WINDOW_MS,
    InboundBatcher,
    type PreparedInbound,
    submitPreparedBatch,
} from "../inboundBatcher.ts";
import type {
    Channel,
    ChannelContext,
    ChannelHandle,
    ChannelMediaRef,
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
    /** Quiet window that closes a chat's inbound batch. Tests set 0. */
    mergeWindowMs?: number;
    /** Upper bound on how long a batch's first message waits for the window. */
    mergeMaxWaitMs?: number;
}

/** Whether the message carried anything the SDK can download. */
function hasMedia(msg: IncomingLike): boolean {
    return (
        (msg.images?.length ?? 0) > 0 ||
        (msg.files?.length ?? 0) > 0 ||
        (msg.voices?.length ?? 0) > 0 ||
        (msg.videos?.length ?? 0) > 0
    );
}

/**
 * The SDK's own text for a media item: a bracketed placeholder ("[image]"),
 * the media's CDN url, or its file name.
 *
 * The SDK joins the items of one message into a single text, so a media line
 * arrives beside the sender's caption — these lines are what the SDK derived
 * from the media, not something the sender wrote.
 */
const MEDIA_PLACEHOLDER = /^(?:\[[^\]]*\]|https?:\/\/\S*)$/;

/**
 * The sender's words on a media message, with the SDK's media lines removed.
 *
 * A message may carry a real caption; that is text the sender wrote and the
 * model should read. The placeholder, the media's url, or a file name says
 * nothing the attachment does not already say. `mediaNames` covers every
 * item in the message, not only the one the downloader picked: an item it
 * skipped would otherwise leave its name behind as if the sender typed it.
 */
function captionFor(text: string, mediaNames: readonly (string | undefined)[]): string {
    const names = new Set(mediaNames.filter((name): name is string => Boolean(name)));
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !MEDIA_PLACEHOLDER.test(line) && !names.has(line));
    return lines.join("\n");
}

/** File names the SDK derived for the message's file items, downloaded or not. */
function sdkFileNames(msg: IncomingLike): string[] {
    return (msg.files ?? []).flatMap((file) => {
        const name = (file as { fileName?: unknown }).fileName;
        return typeof name === "string" && name !== "" ? [name] : [];
    });
}

/**
 * Download the media an incoming message carried, if it carried any.
 *
 * The SDK's downloader picks the file and decrypts it. It returns one file
 * only, so a message carrying several images (or an album) delivers the one
 * the platform selected. A message with no media returns undefined, and so
 * does a download that fails — the sender's text still arrives either way.
 */
async function downloadMessageMedia(
    bot: WeChatBotLike,
    msg: IncomingLike,
): Promise<ChannelMediaRef[] | undefined> {
    if (!hasMedia(msg)) return undefined;
    let downloaded: DownloadedMediaLike | null;
    try {
        downloaded = await bot.download(msg);
    } catch {
        return undefined;
    }
    if (!downloaded) return undefined;
    const name = downloaded.fileName ?? (downloaded.type === "image" ? "image" : "file");
    return [
        {
            kind: downloaded.type === "image" ? "image" : "file",
            name,
            source: {
                kind: "base64",
                mimeType: mimeTypeFromName(name),
                data: downloaded.data.toString("base64"),
            },
        },
    ];
}

/**
 * Download whatever the message carried and take the SDK's media lines out of
 * its text. Returns undefined for a message that is dropped: it carried media
 * the downloader could not fetch, so its text would be a placeholder where the
 * sender meant a picture.
 */
async function prepareInbound(
    ctx: ChannelContext,
    log: Logger,
    bot: WeChatBotLike,
    msg: IncomingLike,
    peerId: string,
    chatId: string,
): Promise<PreparedInbound | undefined> {
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
        raw.message_id ?? raw.client_id ?? raw.seq ?? `${peerId}-${chatId}-${raw.create_time_ms}`,
    );
    const media = await downloadMessageMedia(bot, msg);
    if (hasMedia(msg) && !media) {
        log.warn(`media download failed, message dropped: ${platformMessageId}`);
        return undefined;
    }
    return {
        platformMessageId,
        channelId: ctx.channelId,
        peerId,
        chatId,
        // The SDK's text for a media message is derived from the media — a
        // placeholder, the media's url, its file name. A real caption is the
        // sender's words and stays; the rest would only be noise the model
        // reads past.
        text: media ? captionFor(msg.text, [media[0]?.name, ...sdkFileNames(msg)]) : msg.text,
        media,
    };
}

/** The slice of the SDK surface this channel uses. */
export interface WeChatBotLike {
    login(options?: { force?: boolean; callbacks?: SdkLoginCallbacks }): Promise<unknown>;
    start(): Promise<void>;
    stop(): void;
    send(userId: string, content: string): Promise<void>;
    onMessage(handler: (msg: IncomingLike) => void | Promise<void>): unknown;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
    /** Fetch and decrypt a media file the platform offered. */
    download(message: IncomingLike): Promise<DownloadedMediaLike | null>;
    readonly isRunning: boolean;
}

/** What the SDK's downloader returns for one media file. */
export interface DownloadedMediaLike {
    data: Buffer;
    type: "image" | "file" | "video" | "voice";
    fileName?: string;
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
    /**
     * The media the message carried.
     *
     * The SDK's downloader reads these arrays, so the seam keeps them: a
     * channel that does not look at them can still hand the message back to
     * the downloader unchanged.
     */
    images?: unknown[];
    files?: unknown[];
    voices?: unknown[];
    videos?: unknown[];
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
        // The poller retries network errors forever but emits nothing when one
        // succeeds again, so an `error` set by a blip would outlive the outage.
        // A cursor write (or an inbound message) proves a poll got through.
        // Only `error` is lifted: a mid-bind state belongs to the QR flow.
        const markHealthy = () => {
            if (broker.status(ctx.channelId).state === "error") {
                broker.setState(ctx.channelId, "connected");
            }
        };
        const storage = createStorageAdapter(ctx, (key) => {
            if (key === CURSOR_KEY) markHealthy();
        });

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
        // iLink revoked the token: the SDK wipes the stored credentials, so no
        // retry can recover — only a fresh QR scan.
        bot.on("session:expired", () =>
            broker.setState(ctx.channelId, "unbound", {
                message: "WeChat login expired — bind again to scan a new QR code",
            }),
        );
        bot.on("session:restored", () => broker.setState(ctx.channelId, "connected"));
        bot.on("error", (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            log.error(`bot error: ${message}`);
            broker.setState(ctx.channelId, "error", { message });
        });

        // A picture and the words sent with it are separate platform messages
        // with no guaranteed order between them, and the poller does not wait
        // for one batch before emitting the next. One prompt per message starts
        // a run on whichever arrives first and demotes the other to a follow-up
        // the model only sees after it has answered. Hold each chat's messages
        // for a short quiet window and submit them as one prompt instead.
        const batcher = new InboundBatcher<PreparedInbound | undefined>({
            quietMs: this.options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS,
            maxWaitMs: this.options.mergeMaxWaitMs ?? DEFAULT_MERGE_MAX_WAIT_MS,
            flush: (_key, items) => {
                // A dropped message (failed download) leaves a hole, not text.
                const ready = items.filter((item): item is PreparedInbound => item !== undefined);
                if (ready.length > 0) void submitPreparedBatch(ctx, log, ready);
            },
        });

        bot.onMessage((msg) => {
            markHealthy();
            // chatId groups a conversation: a group shares one session, a 1:1
            // chat falls back to the peer's own id.
            //
            // iLink sends group_id as an EMPTY STRING for 1:1 chats, not
            // undefined, so `??` would let "" through — and an empty chatId
            // produces a workspace key that parseImCwd cannot parse, which
            // silently breaks the reply path (no peer resolves for the session).
            const peerId = msg.userId;
            const chatId = msg.raw.group_id?.trim() || msg.userId;
            // The sender is part of the key as well as the chat: two people
            // writing in a group are two turns, not one.
            batcher.push(
                `${peerId}\u0000${chatId}`,
                prepareInbound(ctx, log, bot, msg, peerId, chatId),
            );
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
            () => batcher.dispose(),
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
        private readonly onClose: () => void,
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
        this.onClose();
    }
}

/** The SDK's storage key for the long-poll cursor (STORAGE_KEYS.CURSOR, not
 *  exported); rewritten after every successful poll. */
const CURSOR_KEY = "cursor";

/** Bridges the SDK's async Storage onto the synchronous ChannelConfigStore. */
function createStorageAdapter(ctx: ChannelContext, onSet: (key: string) => void): SdkStorage {
    return {
        get: async <T>(key: string) => ctx.config.get<T>(key),
        set: async <T>(key: string, value: T) => {
            await ctx.config.set(key, value);
            onSet(key);
        },
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
