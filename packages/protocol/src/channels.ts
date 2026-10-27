/**
 * The IM surface — channels.* RPC types and imPolicy.* workspace policy.
 *
 * Channel credentials never appear here in plaintext: a bound channel reports
 * only `{ configured, mask }`, mirroring how provider API keys cross the wire.
 */

import type { CommandPermissionRule } from "./config.js";
import type { ParamsOf } from "./rpcContract/types.js";
import type {
    channelsBindCredsSchema,
    channelsBindSchema,
    channelsCreateSchema,
    channelsListConversationsSchema,
    channelsListSchema,
    channelsRetrySchema,
    channelsSubmitVerifyCodeSchema,
    channelsUnbindSchema,
    imPolicyClearChatOverrideSchema,
    imPolicyGetSchema,
    imPolicySetChannelDefaultSchema,
    imPolicySetChatOverrideSchema,
} from "./schemas/channels.js";

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
export type ChannelsListParams = ParamsOf<typeof channelsListSchema>;

export interface ChannelsListResult {
    /** Channel types available to instantiate. */
    available: ChannelTypeEntry[];
    /** Configured instances, started or not. */
    configured: ChannelStatusEntry[];
    /** Instances whose start() threw, with the reason. */
    failed: Array<{ channelId: string; error: string }>;
}

export type ChannelsCreateParams = ParamsOf<typeof channelsCreateSchema>;

export interface ChannelsCreateResult {
    channelId: string;
    /**
     * Always true: channels load statically at startup, so a new instance only
     * becomes bindable after a restart. The client shows a restart prompt.
     */
    requiresRestart: boolean;
}

/**
 * Optional credential payload carried by `channels.bind`. Only the WeCom
 * channel consumes it today (static botId + secret from the admin console —
 * no QR flow). Defined at the wire boundary so any future channel needing a
 * non-QR bind can extend the shape.
 */
export type ChannelsBindCreds = ParamsOf<typeof channelsBindCredsSchema>;

export type ChannelsBindParams = ParamsOf<typeof channelsBindSchema>;

export interface ChannelsBindResult {
    channelId: string;
    state: ChannelState;
}

export type ChannelsSubmitVerifyCodeParams = ParamsOf<typeof channelsSubmitVerifyCodeSchema>;

export interface ChannelsSubmitVerifyCodeResult {
    /** False when the request is unknown or already expired. */
    accepted: boolean;
}

export type ChannelsUnbindParams = ParamsOf<typeof channelsUnbindSchema>;

export interface ChannelsUnbindResult {
    channelId: string;
}

/**
 * Reconnect using the channel's already-stored credentials, without forcing the
 * user to retype them. For platforms like WeCom where the SDK caches the
 * credential in its WebSocket client and refuses to retry after its internal
 * reconnect budget is exhausted, this is the only way to get another attempt
 * without clearing the binding. Absent (or a no-op) on channels that don't
 * have this problem — the desktop shows a Retry button only where it's wired. */
export type ChannelsRetryParams = ParamsOf<typeof channelsRetrySchema>;

export interface ChannelsRetryResult {
    channelId: string;
    state: ChannelState;
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

export type ChannelsListConversationsParams = ParamsOf<typeof channelsListConversationsSchema>;

export interface ChannelsListConversationsResult {
    /** Sorted by lastUsedAt descending. */
    conversations: ImConversationEntry[];
}

/** (channelId, peerId, chatId) — identity of one IM conversation. */
export interface ImRoute {
    channelId: string;
    peerId: string;
    chatId: string;
}

export interface ImToolPolicy {
    fsTools: "deny" | "allow";
    shell: "deny" | "allow";
}

export interface ImCommandPolicy {
    mode: "auto" | "ask";
    allow?: CommandPermissionRule[];
    deny?: CommandPermissionRule[];
}

/**
 * Where a channel's tools actually run.
 *
 * - `shared`: one directory shared by every conversation on the channel.
 * - `per-chat`: one directory per conversation.
 * - `custom`: a fixed absolute path.
 *
 * This replaced the old `binding` + `perChatScratch` pair, which described
 * one outcome through two independent fields and made the UI show two
 * conflicting "active" settings.
 */
export type ImExecutionDirMode = "shared" | "per-chat" | "custom";

export interface ImExecutionDir {
    mode: ImExecutionDirMode;
    /** Absolute path. Required when `mode` is `custom`, ignored otherwise. */
    path?: string;
}

export interface ImWorkspacePolicy {
    tools: ImToolPolicy;
    commands: ImCommandPolicy;
    /** Effective working directory for the resolved scope. */
    executionDir: ImExecutionDir;
}

/**
 * Wire-form tool patch. `null` means "remove this field from the current
 * layer" so the value falls back to the parent layer; `undefined` means
 * "leave the stored value untouched".
 */
export interface ImToolPolicyPatch {
    fsTools?: ImToolPolicy["fsTools"] | null;
    shell?: ImToolPolicy["shell"] | null;
}

/**
 * Wire-form command patch. `null` clears the field at the current layer.
 * Rule lists are per-layer additions; the resolver concatenates them with
 * the parent layers instead of replacing them.
 */
export interface ImCommandPolicyPatch {
    mode?: ImCommandPolicy["mode"] | null;
    allow?: CommandPermissionRule[] | null;
    deny?: CommandPermissionRule[] | null;
}

/** A partial policy — any subset of fields, for channel defaults and chat overrides. */
export interface ImWorkspacePolicyPatch {
    tools?: ImToolPolicyPatch;
    commands?: ImCommandPolicyPatch;
    /**
     * Canonical working-directory choice. `null` clears it at this layer so
     * the parent layer decides again.
     */
    executionDir?: ImExecutionDir | null;
    /**
     * Legacy: absolute cwd binding. Still read from existing policy files;
     * superseded by `executionDir` and dropped when that field is written.
     */
    binding?: { executionCwd: string } | null;
    /**
     * Legacy: per-chat scratch flag. Still read from existing policy files;
     * superseded by `executionDir` and dropped when that field is written.
     */
    perChatScratch?: boolean | null;
}

/** Layer that supplied a resolved field value. */
export type ImPolicySource = "default" | "global" | "channel" | "chat";

export interface ImPolicyField<T> {
    value: T;
    source: ImPolicySource;
    /**
     * What the field would resolve to if the scope being described cleared
     * it — the parent layer's value. Lets an editor mark the "follow parent"
     * choice even while the current layer overrides it.
     */
    inherited: { value: T; source: ImPolicySource };
}

/** One layer's contribution to an allow or deny rule list. */
export interface ImPolicyRuleGroup {
    source: "global" | "channel" | "chat";
    rules: CommandPermissionRule[];
    /** True only for the layer currently being edited. */
    editable: boolean;
}

export interface ImPolicySources {
    fsTools: ImPolicyField<ImToolPolicy["fsTools"]>;
    shell: ImPolicyField<ImToolPolicy["shell"]>;
    commandMode: ImPolicyField<ImCommandPolicy["mode"]>;
    executionDir: ImPolicyField<ImExecutionDir>;
}

export interface ImPolicyRulesView {
    allow: ImPolicyRuleGroup[];
    deny: ImPolicyRuleGroup[];
}

export interface ImWorkspacePolicyDocument {
    /**
     * Absent on files written before 0.2.11, where `mode: "auto"` with an
     * `allow` list meant "only these commands". Readers migrate such layers
     * to `mode: "ask"`; every write stamps the current version.
     */
    version?: 2;
    default?: ImWorkspacePolicyPatch;
    chats?: Record<string, ImWorkspacePolicyPatch>;
}

// ─────────────────────────────────────────────────────────────────────
// imPolicy.* RPC types — admin surface for reading / writing policies.
// ─────────────────────────────────────────────────────────────────────

/**
 * `imPolicy.get` params. Pass only `channelId` to fetch the channel-level
 * view (default + every chat override for the channel); pass `peerId` +
 * `chatId` to also resolve the effective policy for that specific chat.
 */
export type ImPolicyGetParams = ParamsOf<typeof imPolicyGetSchema>;

/**
 * One chat override entry. Live conversation overrides carry the `route`;
 * orphan overrides (override exists but conversation is no longer routed)
 * carry only the opaque chats-map `key`. Clearing an orphan needs the
 * `key` since the route cannot be recovered from the sha256.
 */
export interface ImPolicyChatOverrideEntry {
    /** sha256 chats-map key — always present. */
    key: string;
    /** Present iff the key matches a currently routed conversation. */
    route?: ImRoute;
    patch: ImWorkspacePolicyPatch;
}

export interface ImPolicyGetResult {
    channelId: string;
    /** Scope the sources/rules below describe. */
    scope: "channel" | "chat";
    /** Raw stored channel-default patch ({ } when none). */
    channelDefault: ImWorkspacePolicyPatch;
    /**
     * Effective resolved policy for the requested scope:
     * - peerId+chatId given: DEFAULT → channel default → chat override
     * - only channelId: DEFAULT → channel default
     */
    resolved: ImWorkspacePolicy;
    /** The requested chat's override patch, or null. Null when no chat given. */
    chatOverride: ImWorkspacePolicyPatch | null;
    hasOverride: boolean;
    /** All chat overrides for the channel (live + orphan). */
    overrides: ImPolicyChatOverrideEntry[];
    /** Where each resolved single-value field came from. */
    sources: ImPolicySources;
    /** Per-layer rule contributions, inherited groups first. */
    rules: ImPolicyRulesView;
}

export type ImPolicySetChannelDefaultParams = ParamsOf<typeof imPolicySetChannelDefaultSchema>;

export type ImPolicySetChatOverrideParams = ParamsOf<typeof imPolicySetChatOverrideSchema>;

export type ImPolicyClearChatOverrideParams = ParamsOf<typeof imPolicyClearChatOverrideSchema>;

export interface ImPolicyWriteResult {
    channelId: string;
}
