import type { ChannelsBindCreds, ImRoute, ServerPush } from "@taco-ai/protocol";

export interface ChannelManifest {
    readonly name: string;
    readonly version: string;
    readonly capabilities: ChannelCapabilities;
    readonly description?: string;
}

export interface ChannelCapabilities {
    /** Maximum platform text reply length (chars). The only P0 field consumed. */
    readonly maxMessageLength: number;
    readonly requiresPersistentProcess?: boolean;
    readonly approvalButton?: boolean;
}

export interface Channel {
    readonly manifest: ChannelManifest;
    start(ctx: ChannelContext): Promise<ChannelHandle>;
}

/** Sidecar capabilities handed to a Channel at start. channelId injected by ChannelRegistry; channels must not self-report. */
export interface ChannelContext {
    readonly channelId: string;
    readonly ingress: ChannelIngress;
    readonly config: ChannelConfigStore;
    readonly logger: Logger;
}

export interface ChannelIngress {
    /** Submit a message from the channel client. Internally routed via ConversationRouter + dispatchRpc.
     *  Returns sessionId; reply is reserved for P1 passive-reply, always undefined at P0. */
    submit(
        msg: ChannelInboundMessage,
    ): Promise<{ sessionId: string; reply?: ChannelOutboundMessage }>;
}

export interface ChannelConfigStore {
    get<T>(name: string): T | undefined;
    set<T>(name: string, value: T): Promise<void>;
    /** Opaque credential generation, stable across same-account token refresh. */
    getDeliveryBinding?(): string | undefined;
    /** Persist a generation for credentials written before binding tracking existed. */
    ensureDeliveryBinding?(): Promise<void>;
    /** Wipe the whole store — used by unbind to drop credentials and the
     *  SDK's other runtime state (cursor, context tokens). */
    clear(): Promise<void>;
}

/**
 * What a platform said about one outbound message.
 *
 * `push` returns nothing, so a failed send is only a log line. The Work
 * deliverer needs to know which of these happened, because each one calls for
 * a different next step: retry later, wait for the channel, or give up.
 */
export type SendOutboundResult =
    /** The platform accepted the message. */
    | { readonly kind: "confirmed" }
    /** A failure retrying could fix: network, rate limit, timeout. */
    | { readonly kind: "retryable"; readonly code: string; readonly retryAfterMs?: number }
    /** Nothing is connected right now (not bound, reconnecting, stopped). */
    | { readonly kind: "unavailable"; readonly code: string }
    /** The platform refused for a reason that will not change: bad target, no permission. */
    | { readonly kind: "permanentFailure"; readonly code: string };

export interface ChannelHandle {
    push(frame: ServerPush): Promise<void>;
    /** Binding of the client's account, including while disconnected or reconnecting. */
    getDeliveryBinding?(): string | undefined;
    /**
     * Send one already-chunked text to a peer and report what happened.
     *
     * Unlike `push`, this never swallows a failure and never reads a session:
     * the caller names the recipient. Optional so channels with no outbound
     * path (or older ones) simply cannot be used for reliable delivery.
     */
    sendText?(route: ImRoute, text: string): Promise<SendOutboundResult>;
    close(): Promise<void>;
    /**
     * Runs the platform's interactive bind flow (QR scan for wechat) or — for
     * channels without a QR flow — persists `creds` to the channel's store
     * and triggers a reconnect. Progress is reported out-of-band via
     * ChannelBindBroker, not by resolving this. Absent on channels that need
     * no binding (mock).
     */
    login?(force?: boolean, creds?: ChannelsBindCreds): Promise<void>;
    /** Invalidate interactive login immediately, without waiting for the send queue. */
    cancelBinding?(): void;
    /** Discards stored credentials and disconnects. Absent when unbindable. */
    logout?(): Promise<void>;
    /**
     * Optional: reconnect using the channel's already-stored credentials,
     * without forcing the user to retype them. For platforms where the SDK
     * caches credentials in its long-poll client and refuses to retry past
     * its reconnect budget (notably WeCom's 10-attempt ceiling), this is the
     * only way back from error without clearing the binding. Absent when
     * the channel has no stored-credential retry use case. */
    retryWithStoredCreds?(): Promise<void>;
    /**
     * Optional: returns the platform user IDs currently routed through this
     * channel. Lets a workspace-dimensioned frame (no session) broadcast to
     * every peer — e.g. the policy-change interrupt notice. Absent on channels
     * that never emit such notices.
     */
    listPeers?(): string[];
}

/** (channelId, peerId, chatId) — output of ConversationRouter.findRouteBySessionId.
 *  Imported via protocol's ImRoute type so the seam name matches across
 *  sidecar consumers (imPolicy, channelFactory). */
export type ChannelRouteResolver = (sessionId: string) => ImRoute | undefined;

/** Unified inbound message model. kind discriminates the union: P1 platform callbacks / menu clicks use "event". */
export interface ChannelInboundMessage {
    readonly platformMessageId: string;
    readonly channelId: string;
    readonly peerId: string;
    readonly chatId: string;
    readonly kind?: "text" | "event" | "media";
    readonly text: string;
    readonly event?: { type: string; payload: unknown };
    readonly media?: readonly ChannelMediaRef[];
    readonly replyTo?: string;
}

/** P1 passive-reply payload (WeCom / WeChat-MP HTTP sync response). P0 placeholder only. */
export interface ChannelOutboundMessage {
    readonly text: string;
    readonly media?: readonly ChannelMediaRef[];
}

export interface ChannelMediaRef {
    readonly kind: "image" | "file" | "voice";
    readonly source:
        | { kind: "url"; value: string }
        | { kind: "fileId"; value: string }
        | { kind: "base64"; mimeType: string; data: string };
    /**
     * The file name the platform knows it by.
     *
     * It is what the model reads, so `report.pdf` must not arrive as `file`.
     * Ingress adds an extension only when this name has none. A channel that
     * has no name may leave it out.
     */
    readonly name?: string;
}

/** Channel-facing logger contract — a structural subset of `lib/logger.ts`'s
 *  Logger, which satisfies it directly. Do not hand-roll an implementation;
 *  `createLogger(scope)` is the one supported source.
 *
 *  The instance handed to a channel is already scoped to its channelId, so
 *  channels must not prefix messages themselves. Use `child({ sid })` to tag
 *  per-session lines — never pass peerId / chatId as a field: they are platform
 *  user identifiers and logs are persisted to disk. */
export interface Logger {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    child(fields: Record<string, string | number>): Logger;
}
