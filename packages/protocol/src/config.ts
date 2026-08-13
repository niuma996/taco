/**
 * taco.json wire shape + settings/custom-provider/command-permission/extension
 * types. The plaintext apiKey fields live in `TacoGlobalConfigShape` only —
 * use `TacoGlobalConfigView` (masked) for RPC returns.
 */

import type { ChannelInstanceConfig } from "./channels.js";
import type { SessionId, WorkspaceId } from "./frames.js";
import type { ThinkingLevel } from "./messages.js";

/**
 * Wire shape of `taco.json` on disk — the protocol-layer contract.
 * Both client and server import from here to avoid circular dependencies.
 * `extends {}` on `TacoGlobalConfig` preserves nominal isolation.
 *
 * CAUTION: maps directly to disk read/write. **Do not** use as a cross-process
 * RPC return value — that would leak plaintext keys. Use `TacoGlobalConfigView`
 * for RPC returns.
 */
export interface TacoGlobalConfigShape {
    commandPermissions?: CommandPermissionConfig;
    defaultModel?: string;
    defaultProvider?: string;
    sessionsRoot?: string;
    systemPrompt?: string;
    /** Default thinking level; new sessions inherit this. Per-session overrides take precedence. */
    thinkingLevel?: ThinkingLevel;
    anthropicApiKey?: string;
    openaiApiKey?: string;
    apiKeys?: Record<string, string>;
    /**
     * npm package names to load as sidecar extensions at startup.
     * Each package must export a default ExtensionModule factory and
     * declare a `taco` field in its package.json. See
     * docs/superpowers/specs/2026-07-16-sidecar-extensions-design.md.
     */
    extensions?: string[];
    /**
     * Extension names whitelisted in `extensions` but disabled by the user.
     * loader: actual = extensions - disabledExtensions. Coexists with
     * `extensions` rather than replacing it, ensuring zero migration cost.
     */
    disabledExtensions?: string[];
    /**
     * Auto-compaction policy. `enabled` defaults to true; `threshold` defaults
     * to 0.7, meaning compaction triggers when context usage ratio crosses
     * that value. Only affects trigger judgement; does not change pi's
     * internal `prepareCompaction` retention settings (reserveTokens /
     * keepRecentTokens).
     */
    compaction?: CompactionConfig;
    /**
     * Enable user-level memory (topic extraction + <memory> context injection).
     * Defaults to true when unset.
     */
    memoryEnabled?: boolean;
    /**
     * User-defined providers (third-party OpenAI/Anthropic-compatible
     * endpoints). Registered alongside built-in providers. The id must
     * have a `custom:` prefix to avoid colliding with built-in ids.
     * The key lives in `apiKeys[id]`.
     */
    customProviders?: CustomProviderConfig[];
    /**
     * IM channel instances, stored alongside extensions/disabledExtensions.
     * Credentials are NOT here — they live in `$TACO_HOME/channels/<id>.json`,
     * written by the channel itself through its ChannelConfigStore.
     */
    channels?: ChannelInstanceConfig[];
    /**
     * MCP servers whose tools become dynamic-tool candidates. CAUTION: MCP
     * tools are not gated by the command-permission broker — configuring a
     * server is implicit authorization for its tools.
     */
    mcpServers?: McpServerConfig[];
    /** Project-context instructions injection (CLAUDE.md / AGENTS.md / DESIGN.md). */
    instructions?: InstructionsConfig;
}

export type CommandPermissionMode = "ask" | "auto";
export type CommandPermissionScope = "once" | "session" | "global";
export type CommandRisk =
    | "readOnly"
    | "workspaceWrite"
    | "externalSideEffect"
    | "destructive"
    | "privilegeEscape";

/** Runtime value domain of `CommandPermissionMode`. Single source of truth for
 *  both the global config validator and the IM workspace policy validator. */
export const COMMAND_PERMISSION_MODES: ReadonlySet<CommandPermissionMode> = new Set([
    "ask",
    "auto",
]);
/**
 * A single pattern. Syntax is auto-detected:
 * - exact:      `npm install`
 * - wildcard:   `git *`, `mmx *`, `* install`
 */
export type CommandPermissionRule = string;
export interface CommandPermissionConfig {
    mode: CommandPermissionMode;
    rules: CommandPermissionRule[];
}
export interface CommandEvaluation {
    behavior: "allow" | "ask" | "deny";
    risk: CommandRisk;
    reason: string;
    source?: "mode" | "rule" | "channel";
}
export interface CommandPermissionRequest {
    requestId: string;
    sessionId: SessionId;
    toolCallId: string;
    command: string;
    evaluation: CommandEvaluation;
    /** Root session id for UI routing — == sessionId for main-session requests. */
    displaySessionId?: SessionId;
    /** Root agent toolCallId — == toolCallId for main-session requests. */
    displayToolCallId?: string;
}
export type CommandPermissionDenialReason = "user_denied" | "timeout" | "aborted";
export interface CommandPermissionDecision {
    approved: boolean;
    scope: CommandPermissionScope;
    evaluation: CommandEvaluation;
    denialReason?: CommandPermissionDenialReason;
}
export interface CommandPermissionResolveParams {
    workspace: WorkspaceId;
    requestId: string;
    approved: boolean;
    scope: CommandPermissionScope;
}
export interface CommandPermissionResolveResult {
    resolved: boolean;
}

/**
 * Protocols supported by custom providers. Maps to pi's three APIs:
 *  - "chatcomplete" → openai-completions (OpenAI /chat/completions)
 *  - "response"     → openai-responses  (OpenAI /responses)
 *  - "anthropic"    → anthropic-messages (Anthropic /messages)
 */
export type CustomProviderApi = "chatcomplete" | "response" | "anthropic";

/** Custom provider ids must start with this prefix, isolating them from built-in ids. */
export const CUSTOM_PROVIDER_PREFIX = "custom:";

/** One model under a custom provider. pi's `createProvider` requires the full model list at construction. */
export interface CustomModelEntry {
    id: string;
    name?: string;
    /** Context window in tokens, default 128000. */
    contextWindow?: number;
    /** Per-output cap in tokens, default 8192. */
    maxTokens?: number;
}

/** Custom provider config (persisted as `customProviders` in `taco.json`). */
export interface CustomProviderConfig {
    /** Unique id with the `custom:` prefix. */
    id: string;
    name: string;
    api: CustomProviderApi;
    /** Endpoint base URL (e.g. https://api.example.com/v1). */
    baseUrl: string;
    models: CustomModelEntry[];
}

/**
 * Transport kinds for MCP servers. "stdio" spawns a child process;
 * "http" connects to a Streamable HTTP endpoint.
 */
export type McpTransportKind = "stdio" | "http";

/**
 * One MCP server, persisted as an entry of `mcpServers` in `taco.json`.
 *
 * CAUTION: MCP tools execute with the sidecar's own privileges and are NOT
 * gated by the command-permission broker — configuring a server is implicit
 * authorization for every tool it exposes. Only add servers you trust.
 */
export interface McpServerConfig {
    /** Unique id, used as the tool-name prefix. Charset `[a-zA-Z0-9_-]`. */
    id: string;
    transport: McpTransportKind;
    /** Default true; false skips the server entirely. */
    enabled?: boolean;
    /** Required for stdio. */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    /** Defaults to the workspace cwd. */
    cwd?: string;
    /** Required for http. */
    url?: string;
    headers?: Record<string, string>;
    /** Timeout for connect / listTools / callTool, default 15000. */
    timeoutMs?: number;
    /**
     * These MCP-side raw tool names (no prefix) become loading:"always" —
     * resident from session start. Everything else is deferred.
     */
    alwaysLoaded?: string[];
}

/**
 * Per-server health snapshot returned by `mcp.listServers`.
 *
 * - `status: "ok"`     — the server connected and listTools succeeded.
 * - `status: "error"`  — connect or listTools failed; `connectError` carries the reason.
 * - `status: "skipped"` — the server is `enabled: false` and the handler chose
 *                        not to spawn it (see `mcp.listServers` for the policy).
 *                        `tools` is empty and `connectError` is undefined.
 */
export interface McpServerView {
    id: string;
    transport: McpTransportKind;
    status: "ok" | "error" | "skipped";
    /** Number of tools exposed by this server. */
    toolCount: number;
    /** Raw tool names, in the order returned by the server. */
    tools: string[];
    /** Set when status === "error"; undefined otherwise. */
    connectError?: string;
}

export interface McpListServersResult {
    servers: McpServerView[];
}

/** `mcp.getConfig` params — fetch one raw MCP server config for editing. */
export interface McpGetConfigParams {
    id: string;
}
export interface McpGetConfigResult {
    config: McpServerConfig;
}
export interface McpCreateConfigParams {
    config: McpServerConfig;
}
/** Shared result for create / update — safe summary + restart requirement. */
export interface McpMutateConfigResult {
    server: McpServerConfigView;
    requiresRestart: true;
}
export interface McpUpdateConfigParams {
    id: string;
    /** Field-wise merge — absent fields keep their current value. */
    patch: Partial<McpServerConfig>;
}
export interface McpDeleteConfigParams {
    id: string;
}
export interface McpDeleteConfigResult {
    deleted: string;
    requiresRestart: true;
}

/**
 * CompactionConfig — auto-compaction policy block in `taco.json`.
 *
 * Trigger: `usedTokens > model.contextWindow * threshold`. Equivalently,
 * `reserveTokens = ctx * (1 - threshold)`, the inverse of pi's built-in
 * `shouldCompact` formula `usedTokens > contextWindow - reserveTokens`.
 *
 * `threshold ∈ [0, 1]`, default 0.7. `enabled === false` suspends
 * auto-compaction; manual `session.compact` RPC still works.
 */
export interface CompactionConfig {
    enabled?: boolean;
    /** Upper bound on context usage ratio, default 0.7. */
    threshold?: number;
}

/** Default compaction trigger threshold — used when no value is set in `taco.json`. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.7;
/** Default `compaction.enabled` value when no setting is provided. */
export const DEFAULT_COMPACTION_ENABLED = true;
/**
 * Inclusive bounds for the product-side threshold clamp. Centralized here so
 * the sidecar (settings.write validator) and any client UI share a single
 * source of truth — independent UIs can no longer drift out of sync.
 */
export const COMPACTION_THRESHOLD_MIN = 0.1;
export const COMPACTION_THRESHOLD_MAX = 0.95;

/**
 * Masked API key view used by settings RPC returns.
 *
 * Replaces the raw string fields of `TacoGlobalConfigShape` so the desktop
 * cache / network frame never carries the actual key material. `mask`
 * keeps the provider prefix + last 4 chars (e.g. `sk-ant-…AbCd`) so the
 * user can tell which key is configured without seeing the secret.
 */
export interface MaskedKey {
    configured: boolean;
    /** Like `sk-ant-…AbCd`. Only present when configured=true. */
    mask?: string;
}

/**
 * Safe view of a single `ChannelInstanceConfig`. Strips the channel-defined
 * `config` blob because channel SDKs may write their own secrets there
 * (an extension channel could choose to keep API keys in
 * `channels[i].config`).
 */
export interface ChannelInstanceConfigView {
    channelId: string;
    manifest: { name: string; version: string };
    // `config` deliberately omitted — see ChannelInstanceConfig.
}

/**
 * Safe view of a single `McpServerConfig`. Strips every field that can
 * carry a secret or arbitrary executable path: `env`, `headers`,
 * `command`, `args`, `url`. The desktop cache / IPC payload never
 * carries these, so users cannot accidentally paste them into logs or
 * support tickets.
 */
export type McpServerConfigView = Omit<
    McpServerConfig,
    "env" | "headers" | "command" | "args" | "url" | "cwd"
>;

/**
 * Safe view of `TacoGlobalConfigShape` — the shape returned by
 * `settings.get` / `settings.write`. Never contains raw secret material:
 *  - API key fields are replaced with `MaskedKey`.
 *  - `channels[i].config` is omitted entirely (see ChannelInstanceConfigView).
 *  - `mcpServers[i]` has `env` / `headers` / `command` / `args` / `url`
 *    stripped (see McpServerConfigView).
 *
 * Field names mirror `TacoGlobalConfigShape` so consumers can switch by
 * type only — `TacoGlobalConfigView extends Omit<TacoGlobalConfigShape, ...>`
 * keeps the other fields (defaultModel / extensions / ...) byte-identical.
 */
export interface TacoGlobalConfigView
    extends Omit<
        TacoGlobalConfigShape,
        "anthropicApiKey" | "openaiApiKey" | "apiKeys" | "channels" | "mcpServers"
    > {
    anthropicApiKey?: MaskedKey;
    openaiApiKey?: MaskedKey;
    apiKeys?: Record<string, MaskedKey>;
    channels?: ChannelInstanceConfigView[];
    mcpServers?: McpServerConfigView[];
}

/** `settings.get` RPC params (currently no required input; reserved for future). */
export type SettingsGetParams = object;

/** `settings.get` RPC result — sidecar global config view (key fields masked, never plaintext). */
export interface SettingsGetResult {
    /** From the sidecar process (reads ~/.taco/taco.json); key fields are masked. */
    global: TacoGlobalConfigView;
}

/**
 * `settings.write` RPC params — write the sidecar global config to
 * `~/.taco/taco.json`.
 *
 * NOTE: this RPC does not accept client-side patches. Client-local
 * settings (theme / debugMode, ...) are written by the client itself to
 * localStorage / Tauri app config, not via the sidecar. `SettingsWriteParams.client`
 * is intentionally absent to prevent misuse of the RPC.
 */
export interface SettingsWriteParams {
    /** Sidecar config patch, merged back to `~/.taco/taco.json`. */
    global?: Partial<TacoGlobalConfigShape>;
}

/**
 * Project-context instructions injection — controls whether TACO reads
 * CLAUDE.md / AGENTS.md / DESIGN.md from the workspace and parent directories,
 * wraps them as `<instructions>` tags, and prepends to every LLM call.
 *
 * Defaults match the existing behavior (CLAUDE.md enabled, plus AGENTS.md
 * for compatibility with other agents) but keep DESIGN.md opt-in since it is
 * not a widely-recognized convention.
 */
export interface InstructionsConfig {
    /** Master switch — when false, no file is read, no tag is injected. */
    enabled?: boolean;
    /**
     * Per-file switches. `undefined` defaults to the documented value
     * (true for CLAUDE.md / AGENTS.md, false for DESIGN.md) so a partial
     * patch only flips the explicitly-named files.
     */
    files?: {
        claudeMd?: boolean;
        agentsMd?: boolean;
        designMd?: boolean;
    };
    /**
     * Absolute-path overrides — when set, skip the directory-priority lookup
     * and read the named file directly. Useful for projects that keep
     * instructions in an unusual layout (e.g. `docs/AGENTS.md`).
     */
    filesOverride?: {
        claudeMd?: string;
        agentsMd?: string;
        designMd?: string;
    };
    /** Subagent inheritance — when true, parent instructions are also
     *  inherited by spawned subagents via the rebuilt system prompt. */
    inheritToSubagents?: boolean;
}

/** `settings.write` RPC result — latest view after write-back (key fields masked). */
export interface SettingsWriteResult {
    /** Sidecar global config view after write-back; key fields are masked. */
    global: TacoGlobalConfigView;
}

/**
 * Extension contract primitives. This is the single source of truth —
 * `@taco-ai/sidecar`'s extension types re-export these (protocol is a leaf
 * package, sidecar depends on it). Do not re-declare them downstream.
 */
/** A permission slot — corresponds to one extension register* method. */
export type ExtensionPermission =
    | "context"
    | "toolCall"
    | "toolResult"
    | "tools"
    | "systemPrompt"
    | "tags";
/** Discriminator used to bucket extension contributions by origin. */
export type ExtensionSource = "builtin" | "external";

/** `extensions.status` RPC — returns the current extension registry's status. */
export type ExtensionsStatusParams = object;

export interface ExtensionStatusEntry {
    name: string;
    version: string;
    source: ExtensionSource;
    permissions: ReadonlyArray<ExtensionPermission>;
    /** Short description ("what it does"), from manifest `taco.description`. May be absent. */
    description?: string;
    /** Activation hint ("when to use"), from manifest `taco.whenToUse`. May be absent. */
    whenToUse?: string;
    /** Tag names registered by this extension via `registerTag`. Only populated for loaded entries. */
    tags?: ReadonlyArray<string>;
}

export interface ExtensionsStatusResult {
    loaded: ExtensionStatusEntry[];
    failed: Array<{ name: string; reason: string }>;
    unauthorized: Array<{ name: string; method: string }>;
    /**
     * Extension names disabled via `disabledExtensions` and therefore not
     * loaded. Only the name is exposed — disabled = not loaded = manifest
     * unread, so version/permissions/description are unavailable. Mutually
     * exclusive with `loaded`/`failed`/`unauthorized` (the loader routes
     * them at the subtraction step).
     */
    disabled: string[];
}
