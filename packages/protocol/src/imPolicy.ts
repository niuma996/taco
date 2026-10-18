/**
 * IM workspace policy types — per-(channel, chat) capability grants.
 *
 * Pure-data interfaces that cross the wire (admin RPC, push payloads).
 * Merged into resolved effective policy at workspace construction time
 * (see @taco-ai/sidecar `channels/imWorkspacePolicy.ts` for the merge
 * logic and `chatPolicyKey` helper). Named `ImWorkspacePolicy` deliberately,
 * NOT `ChannelCapabilities` — that name is taken by channels/types.ts for
 * platform traits (maxMessageLength, approvalButton) and must not be
 * conflated with admin-granted policy.
 *
 * Wire contract: every field is optional in the patch form; merging
 * preserves omitted fields so editing one field does not silently revoke
 * unrelated grants.
 */

import type { CommandPermissionRule } from "./config.js";

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
export interface ImPolicyGetParams {
    channelId: string;
    peerId?: string;
    chatId?: string;
}

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

export interface ImPolicySetChannelDefaultParams {
    channelId: string;
    patch: ImWorkspacePolicyPatch;
}

export interface ImPolicySetChatOverrideParams {
    channelId: string;
    peerId: string;
    chatId: string;
    patch: ImWorkspacePolicyPatch;
}

export interface ImPolicyClearChatOverrideParams {
    channelId: string;
    /**
     * Either the full route triple (preferred; matches by `chatPolicyKey` on
     * the server) OR a raw `chatKey` (64-char sha256 hex) when the
     * conversation that owned the override is no longer routed and the
     * route cannot be reconstructed. Provide one of `peerId+chatId` or
     * `chatKey`; the server rejects ambiguous or empty input.
     */
    peerId?: string;
    chatId?: string;
    chatKey?: string;
}

export interface ImPolicyWriteResult {
    channelId: string;
}
