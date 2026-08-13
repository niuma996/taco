/**
 * channels.* RPC types — IM channel listing, binding and unbinding.
 *
 * Channel credentials never appear here in plaintext: a bound channel reports
 * only `{ configured, mask }`, mirroring how provider API keys cross the wire.
 */

/**
 * Prefix marking a virtual IM workspace cwd (`im://<channelId>/<peerId>/<chatId>`).
 * Lives here (like CUSTOM_PROVIDER_PREFIX) because the desktop client needs to
 * recognize it too — to hide fs-only UI and exclude these cwds from the
 * project-folder picker — not just the sidecar that constructs the key.
 */
export const IM_CWD_PREFIX = "im://";

/**
 * Build an IM virtual workspace key. channelId is already constrained by
 * configValidator to /^[a-z0-9][a-z0-9-]*$/ (no /, %), so only peerId/chatId
 * need encoding.
 */
/** @throws if peerId or chatId is empty — such a key cannot round-trip. */
export function makeImCwd(channelId: string, peerId: string, chatId: string): string {
    // An empty peerId/chatId yields a key parseImCwd cannot parse, which breaks
    // the reply path silently (the session exists but no peer resolves for it).
    // Fail loudly at construction instead.
    if (!peerId) throw new Error("makeImCwd: peerId must not be empty");
    if (!chatId) throw new Error("makeImCwd: chatId must not be empty");
    return `${IM_CWD_PREFIX}${channelId}/${encodeURIComponent(peerId)}/${encodeURIComponent(chatId)}`;
}

export function parseImCwd(
    cwd: string,
): { channelId: string; peerId: string; chatId: string } | undefined {
    if (!cwd.startsWith(IM_CWD_PREFIX)) return undefined;
    const rest = cwd.slice(IM_CWD_PREFIX.length);
    // Use first/last slash to locate the three segments; peerId with encoded "/" (%2F) round-trips correctly.
    const firstSlash = rest.indexOf("/");
    const lastSlash = rest.lastIndexOf("/");
    if (firstSlash <= 0 || firstSlash === lastSlash) return undefined;
    const channelId = rest.slice(0, firstSlash);
    const peerIdRaw = rest.slice(firstSlash + 1, lastSlash);
    const chatIdRaw = rest.slice(lastSlash + 1);
    if (!channelId || !peerIdRaw || !chatIdRaw) return undefined;
    try {
        return {
            channelId,
            peerId: decodeURIComponent(peerIdRaw),
            chatId: decodeURIComponent(chatIdRaw),
        };
    } catch {
        return undefined;
    }
}

/** Lifecycle of one channel's binding, as observed by the client. */
export type ChannelState =
    | "unbound"
    | "awaiting_scan"
    | "scanned"
    | "awaiting_verify_code"
    | "connecting"
    | "connected"
    | "expired"
    | "error";

/**
 * One channel instance as persisted in taco.json. The embedded manifest is a
 * snapshot for validation/routing; the live manifest comes from the channel
 * implementation the factory resolves by `manifest.name`.
 */
export interface ChannelInstanceConfig {
    channelId: string;
    manifest: { name: string; version: string };
    config: Record<string, unknown>;
}

/** A channel type the sidecar can instantiate. */
export interface ChannelTypeEntry {
    /** Manifest name, e.g. "wechat". */
    name: string;
    version: string;
    description?: string;
    /** Platform text reply cap in chars. */
    maxMessageLength: number;
    /** True when the channel holds a long-lived connection. */
    requiresPersistentProcess: boolean;
    /** True when the platform can render interactive approval cards. */
    approvalButton: boolean;
}

/** A configured channel instance and its live binding state. */
export interface ChannelStatusEntry {
    /** Runtime id, the taco.json key. */
    channelId: string;
    /** Manifest name of the channel type backing this instance. */
    name: string;
    state: ChannelState;
    /** True once credentials are stored, regardless of current connectivity. */
    configured: boolean;
    /** QR payload to render; present while `awaiting_scan`. */
    qrUrl?: string;
    /** Pending verify-code requestId; present while `awaiting_verify_code`. */
    requestId?: string;
    /** True when a previously submitted verify code was rejected. */
    retry?: boolean;
    /** Human-readable detail, typically the last error. */
    message?: string;
}

/** `channels.list` RPC params — a process-level call with no input. */
export type ChannelsListParams = object;

export interface ChannelsListResult {
    /** Channel types available to instantiate. */
    available: ChannelTypeEntry[];
    /** Configured instances, started or not. */
    configured: ChannelStatusEntry[];
    /** Instances whose start() threw, with the reason. */
    failed: Array<{ channelId: string; error: string }>;
}

export interface ChannelsCreateParams {
    /** Manifest name of the channel type to instantiate, e.g. "wechat". */
    name: string;
    /** Runtime id; defaults to `name` when omitted. Must match /^[a-z0-9][a-z0-9-]*$/. */
    channelId?: string;
}

export interface ChannelsCreateResult {
    channelId: string;
    /**
     * Always true: channels load statically at startup, so a new instance only
     * becomes bindable after a restart. The client shows a restart prompt.
     */
    requiresRestart: boolean;
}

export interface ChannelsBindParams {
    channelId: string;
    /** Discard stored credentials and re-run the full QR flow. */
    force?: boolean;
}

export interface ChannelsBindResult {
    channelId: string;
    state: ChannelState;
}

export interface ChannelsSubmitVerifyCodeParams {
    requestId: string;
    code: string;
}

export interface ChannelsSubmitVerifyCodeResult {
    /** False when the request is unknown or already expired. */
    accepted: boolean;
}

export interface ChannelsUnbindParams {
    channelId: string;
}

export interface ChannelsUnbindResult {
    channelId: string;
}

/** `channel.status_changed` push params. Workspace-dimensioned (no session). */
export interface ChannelStatusChangedParams {
    channel: ChannelStatusEntry;
}

/**
 * One IM conversation — a (channelId, peerId, chatId) triple with its taco
 * session. The desktop client has no other way to discover these: they are
 * created passively by inbound messages, never by a user picking a folder.
 */
export interface ImConversationEntry {
    channelId: string;
    peerId: string;
    chatId: string;
    sessionId: string;
    /** Epoch ms — matches ConversationRouter's internal RouteEntry, not the
     *  ISO strings SessionListEntry uses (no session-list identity here). */
    lastUsedAt: number;
}

export interface ChannelsListConversationsParams {
    /** Restrict to one channel instance; omit for all. */
    channelId?: string;
}

export interface ChannelsListConversationsResult {
    /** Sorted by lastUsedAt descending. */
    conversations: ImConversationEntry[];
}
