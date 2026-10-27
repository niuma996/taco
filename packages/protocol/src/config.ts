/**
 * The on-disk config shape — `taco.json` — plus the views that project it.
 *
 * The plaintext apiKey fields live in `TacoGlobalConfigShape` only; use
 * `TacoGlobalConfigView` (masked) for anything that leaves the process. The
 * RPC request and result types live with their contract rows in
 * `rpcContract/settings.ts`, and the open-body patch types in
 * `configPatch.ts`.
 */

import type { ChannelInstanceConfig } from "./channels.js";
import type { SessionId, ToolCallId } from "./frames.js";
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
     * to 0.7. Both fields are ratios of the model's context window: the
     * threshold sets when compaction triggers and how much recent context is
     * retained afterwards. See `CompactionConfig`.
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
     * User-added models for built-in providers (fetched from the provider's
     * /models endpoint or typed manually), keyed by built-in provider id.
     * Merged into the catalog on top of pi's static lists; custom providers
     * keep their models in `customProviders[].models` instead.
     */
    providerExtraModels?: Record<string, CustomModelEntry[]>;
    /**
     * Static model ids the user removed from a built-in provider's list,
     * keyed by built-in provider id. pi's static list is immutable, so a
     * removal is a filter over it — the entries stay available for restore
     * via the settings UI. Extras and removals are independent: hiding a
     * static id does not drop a user-added entry of the same name.
     */
    providerHiddenModels?: Record<string, string[]>;
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
    /** Commands that are always allowed unless a deny rule also matches. */
    allow?: CommandPermissionRule[];
    /** Commands that always require interactive approval. */
    deny?: CommandPermissionRule[];
    /** Legacy alias accepted on disk and normalized into allow. */
    rules?: CommandPermissionRule[];
    /** Additional absolute directory roots authorized for static shell directory changes. */
    allowedDirectories?: string[];
}
export interface CommandEvaluation {
    behavior: "allow" | "ask" | "deny";
    risk: CommandRisk;
    reason: string;
    source?: "mode" | "rule" | "channel";
    matchedList?: "allow" | "deny";
    matchedRule?: CommandPermissionRule;
    triggeringCommand?: string;
    /** False when a stored approval cannot safely apply to this syntax. */
    persistentAllowed?: boolean;
}
/**
 * What a pending approval is about.
 *
 * `command` is the default and the historical shape: a shell command the
 * broker evaluated. `config` is a global-config change — there is no command
 * to evaluate, so the broker asks unconditionally and the UI shows the fields
 * being changed instead of a command line.
 */
export type PermissionRequestKind = "command" | "config";
export interface CommandPermissionRequest {
    requestId: string;
    sessionId: SessionId;
    toolCallId: ToolCallId;
    command: string;
    evaluation: CommandEvaluation;
    /** Absent means "command" — the shape every pre-config client expects. */
    kind?: PermissionRequestKind;
    /**
     * For kind="config": the config fields being changed, for the approval
     * prompt to show. Empty for kind="command".
     */
    configFields?: readonly string[];
    /** Root session id for UI routing — == sessionId for main-session requests. */
    displaySessionId?: SessionId;
    /** Root agent toolCallId — == toolCallId for main-session requests. */
    displayToolCallId?: ToolCallId;
}
/** `no_approver`: an IM request with no desktop client connected to answer it. */
export type CommandPermissionDenialReason = "user_denied" | "timeout" | "aborted" | "no_approver";
export interface CommandPermissionDecision {
    approved: boolean;
    scope: CommandPermissionScope;
    evaluation: CommandEvaluation;
    denialReason?: CommandPermissionDenialReason;
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
    /**
     * Whether the model reasons before answering. Left unset, the model
     * inherits the capability of the provider it is added to — a model the
     * provider lists as a thinking model is one, even when the user adds it
     * by hand.
     *
     * This is not cosmetic: pi only sends `thinking: {type:"disabled"}` to a
     * model it believes thinks. A thinking model left marked as
     * non-reasoning keeps thinking by default, and the reasoning tokens eat
     * the output budget — a request for a short JSON answer can come back
     * with no text at all.
     */
    reasoning?: boolean;
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
 * CompactionConfig — auto-compaction policy block in `taco.json`.
 *
 * Trigger: `usedTokens > model.contextWindow * threshold`.
 *
 * The same threshold sizes how much recent context survives compaction:
 * `keepRecentTokens` is derived as a fraction of `contextWindow * threshold`,
 * so a higher threshold means both "compact later" and "keep more afterwards".
 * `reserveTokens` is derived independently (capped at pi's default of 16384)
 * and bounds the summary's output budget, which is why it is not simply
 * `ctx * (1 - threshold)`. See `deriveCompactionSettings` in the sidecar.
 *
 * `threshold ∈ [0, 1]`, default 0.7. `enabled === false` suspends
 * auto-compaction on both paths — the `run_end` check and pi's turn-boundary
 * overflow check; manual `session.compact` RPC still works.
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
