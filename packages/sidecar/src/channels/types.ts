import type { ServerPush } from "@taco-ai/protocol";

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
    /** Wipe the whole store — used by unbind to drop credentials and the
     *  SDK's other runtime state (cursor, context tokens). */
    clear(): Promise<void>;
}

export interface ChannelHandle {
    push(frame: ServerPush): Promise<void>;
    close(): Promise<void>;
    /** Runs the platform's interactive bind flow (e.g. QR login). Progress is
     *  reported out-of-band via ChannelBindBroker, not by resolving this.
     *  Absent on channels that need no binding (mock). */
    login?(force?: boolean): Promise<void>;
    /** Discards stored credentials and disconnects. Absent when unbindable. */
    logout?(): Promise<void>;
    /**
     * Optional: returns the platform user IDs currently routed through this
     * channel. Lets a workspace-dimensioned frame (no session) broadcast to
     * every peer — e.g. the policy-change interrupt notice. Absent on channels
     * that never emit such notices.
     */
    listPeers?(): string[];
}

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
