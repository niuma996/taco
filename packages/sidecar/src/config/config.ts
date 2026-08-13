/**
 * Taco config loading — TACO_HOME root (default ~/.taco).
 *
 * Loading order (later overrides earlier):
 *   1. env vars (ANTHROPIC_API_KEY, TACO_*, ...)
 *   2. global config: $TACO_HOME/taco.json
 *   3. CLI args (--default-model, ...)
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
    COMMAND_PERMISSION_MODES,
    COMPACTION_THRESHOLD_MAX,
    COMPACTION_THRESHOLD_MIN,
    type CommandPermissionConfig,
    type CommandPermissionMode,
    type CommandPermissionRule,
    type CompactionConfig,
    CUSTOM_PROVIDER_PREFIX,
    type CustomModelEntry,
    type CustomProviderApi,
    type CustomProviderConfig,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_THRESHOLD,
    type InstructionsConfig,
    type McpServerConfig,
    type McpTransportKind,
    type TacoGlobalConfigShape,
} from "@taco-ai/protocol";
import type { ChannelConfig } from "../channels/registry.ts";
import { restrictOwnerSync } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";
import { validatePermissionRule } from "../permissions/shellRuleMatching.ts";
import { resourceRoot } from "../runtime/runtimeResources.ts";
import { tacoHome } from "./tacoHome.ts";

const log = createLogger("config");

/**
 * Re-export the protocol-level compaction constants so legacy callers can
 * keep importing them from `@taco-ai/sidecar`. New code should import from
 * `@taco-ai/protocol` directly.
 */
export {
    COMPACTION_THRESHOLD_MAX,
    COMPACTION_THRESHOLD_MIN,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_THRESHOLD,
} from "@taco-ai/protocol";
export { tacoHome };

export interface ResolvedCompaction {
    enabled: boolean;
    threshold: number;
}

export interface ResolvedTacoConfig {
    defaultModel?: string;
    defaultProvider?: string;
    sessionsRoot?: string;
    systemPrompt?: string;
    /**
     * Resolved default thinking level. Resolution order: CLI override > global config.
     * `undefined` means "unset", harness falls back to `"off"`.
     */
    defaultThinkingLevel?: ThinkingLevel;
    apiKeys: Record<string, string>;
    /** npm package names to load as sidecar extensions at startup. */
    extensions?: string[];
    /** npm package names to skip loading (taco.json disabledExtensions). */
    disabledExtensions?: string[];
    /** Resolved compaction strategy (all fields filled in at parse time, non-optional). */
    compaction: ResolvedCompaction;
    /** Enable user-level memory. `undefined` = default (enabled). */
    memoryEnabled?: boolean;
    /** Validated custom providers. Omitted when empty. */
    customProviders?: CustomProviderConfig[];
    /** IM channel configs loaded from taco.json / CLI. */
    channels?: ChannelConfig[];
    /** MCP servers (validated). Omitted when none are configured. */
    mcpServers?: McpServerConfig[];
    /** Project-context instructions injection (CLAUDE.md / AGENTS.md / DESIGN.md). */
    instructions?: InstructionsConfig;
}

/** pi thinkingLevel value domain whitelist — superset (including `max`) reserved for future-compat. */
export const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set<ThinkingLevel>([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
]);

function isThinkingLevel(v: unknown): v is ThinkingLevel {
    return typeof v === "string" && (THINKING_LEVELS as Set<string>).has(v);
}

/** Validate and normalise the thinkingLevel field; `undefined` / `null` treated as "unset" → undefined; invalid values throw Error. */
function validateThinkingLevel(value: unknown, source: string): ThinkingLevel | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isThinkingLevel(value)) {
        throw new Error(`invalid thinkingLevel from ${source}: ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Validate and normalise the `compaction` field:
 *   - `undefined` / `null` → "unset" → undefined
 *   - Must be a non-array object
 *   - `enabled` if present must be a boolean
 *   - `threshold` if present must be a finite number in [0.1, 0.95]
 *   - Invalid values throw Error
 */
export function validateCompactionConfig(
    value: unknown,
    source: string,
): ResolvedCompaction | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid compaction from ${source}: expected object, got ${typeof value}`);
    }
    const obj = value as Record<string, unknown>;
    const enabled = obj.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
        throw new Error(`invalid compaction.enabled from ${source}: expected boolean`);
    }
    const thresholdRaw = obj.threshold;
    let threshold = DEFAULT_COMPACTION_THRESHOLD;
    if (thresholdRaw !== undefined) {
        if (typeof thresholdRaw !== "number" || !Number.isFinite(thresholdRaw)) {
            throw new Error(`invalid compaction.threshold from ${source}: expected finite number`);
        }
        if (thresholdRaw < COMPACTION_THRESHOLD_MIN || thresholdRaw > COMPACTION_THRESHOLD_MAX) {
            throw new Error(
                `invalid compaction.threshold from ${source}: must be in [${COMPACTION_THRESHOLD_MIN}, ${COMPACTION_THRESHOLD_MAX}], got ${thresholdRaw}`,
            );
        }
        threshold = thresholdRaw;
    }
    return {
        enabled: enabled ?? DEFAULT_COMPACTION_ENABLED,
        threshold,
    };
}

/**
 * In whitelist-writes scenarios, merge a loose `CompactionConfig` patch into an existing `ResolvedCompaction`.
 * Unlike `validateCompactionConfig` (which validates the whole object at once), this is a
 * shallow-merge path: existing → patch field-level overrides → per-field validation → new ResolvedCompaction.
 */
export function mergeCompactionPatch(
    current: ResolvedCompaction,
    patch: Partial<CompactionConfig> | undefined,
    source: string,
): ResolvedCompaction {
    if (!patch || typeof patch !== "object") return current;
    const obj = patch as Record<string, unknown>;
    let enabled = current.enabled;
    let threshold = current.threshold;
    if ("enabled" in obj && obj.enabled !== undefined) {
        if (typeof obj.enabled !== "boolean") {
            throw new Error(`invalid compaction.enabled from ${source}: expected boolean`);
        }
        enabled = obj.enabled;
    }
    if ("threshold" in obj && obj.threshold !== undefined) {
        const v = obj.threshold;
        if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error(`invalid compaction.threshold from ${source}: expected finite number`);
        }
        if (v < COMPACTION_THRESHOLD_MIN || v > COMPACTION_THRESHOLD_MAX) {
            throw new Error(
                `invalid compaction.threshold from ${source}: must be in [${COMPACTION_THRESHOLD_MIN}, ${COMPACTION_THRESHOLD_MAX}]`,
            );
        }
        threshold = v;
    }
    return { enabled, threshold };
}

/**
 * Validate an `InstructionsConfig` patch (partial, from settings.write or
 * taco.json). All fields optional — the resolver (`resolveInstructions`)
 * fills defaults. Throws on any malformed leaf so a bad patch fails the
 * whole write before anything lands on disk.
 */
export function validateInstructionsConfig(
    value: unknown,
    source: string,
): Partial<InstructionsConfig> | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(
            `invalid instructions from ${source}: expected object, got ${typeof value}`,
        );
    }
    const obj = value as Record<string, unknown>;
    if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
        throw new Error(`invalid instructions.enabled from ${source}: expected boolean`);
    }
    if (obj.inheritToSubagents !== undefined && typeof obj.inheritToSubagents !== "boolean") {
        throw new Error(`invalid instructions.inheritToSubagents from ${source}: expected boolean`);
    }
    const boolKeys = ["claudeMd", "agentsMd", "designMd"] as const;
    if (obj.files !== undefined) {
        if (typeof obj.files !== "object" || Array.isArray(obj.files) || obj.files === null) {
            throw new Error(`invalid instructions.files from ${source}: expected object`);
        }
        for (const k of boolKeys) {
            const v = (obj.files as Record<string, unknown>)[k];
            if (v !== undefined && typeof v !== "boolean") {
                throw new Error(`invalid instructions.files.${k} from ${source}: expected boolean`);
            }
        }
    }
    if (obj.filesOverride !== undefined) {
        if (
            typeof obj.filesOverride !== "object" ||
            Array.isArray(obj.filesOverride) ||
            obj.filesOverride === null
        ) {
            throw new Error(`invalid instructions.filesOverride from ${source}: expected object`);
        }
        for (const k of boolKeys) {
            const v = (obj.filesOverride as Record<string, unknown>)[k];
            if (v !== undefined && typeof v !== "string") {
                throw new Error(
                    `invalid instructions.filesOverride.${k} from ${source}: expected string (absolute path)`,
                );
            }
        }
    }
    return obj as Partial<InstructionsConfig>;
}

/**
 * Nested-merge an `InstructionsConfig` patch onto the current value. Per-field
 * override semantics: any leaf present in `patch` replaces the current leaf;
 * leaves absent from `patch` are preserved (so `{ files: { claudeMd: false } }`
 * flips only claudeMd, leaving agentsMd / designMd untouched). The result is
 * re-validated so a partial patch can never produce a malformed record.
 */
export function mergeInstructionsPatch(
    current: InstructionsConfig | undefined,
    patch: Partial<InstructionsConfig> | undefined,
    source: string,
): InstructionsConfig | undefined {
    if (!patch || typeof patch !== "object") return current;
    const validated = validateInstructionsConfig(patch, source);
    if (!validated) return current;
    const base = current ?? {};
    const merged: InstructionsConfig = {};
    if (validated.enabled !== undefined) merged.enabled = validated.enabled;
    else if (base.enabled !== undefined) merged.enabled = base.enabled;
    // files / filesOverride are deep-merged so a partial patch (e.g. only
    // `{ files: { claudeMd: false } }`) flips only the named leaf. Skip the
    // key entirely when neither side has it — matches the "absent = use
    // default" convention the resolver relies on.
    if (base.files !== undefined || validated.files !== undefined) {
        merged.files = { ...(base.files ?? {}), ...(validated.files ?? {}) };
    }
    if (base.filesOverride !== undefined || validated.filesOverride !== undefined) {
        merged.filesOverride = {
            ...(base.filesOverride ?? {}),
            ...(validated.filesOverride ?? {}),
        };
    }
    if (validated.inheritToSubagents !== undefined) {
        merged.inheritToSubagents = validated.inheritToSubagents;
    } else if (base.inheritToSubagents !== undefined) {
        merged.inheritToSubagents = base.inheritToSubagents;
    }
    return merged;
}

/** Global config path: $TACO_HOME/taco.json — internal to the config module only */
function tacoGlobalConfigPath(): string {
    return resolvePath(tacoHome(), "taco.json");
}

/** Input dirs for loadSourcedSkills — each annotated with source, consumed by mapSkill to stamp TacoSkill. */
export interface SkillDirInput {
    path: string;
    source: "builtin" | "user";
}

/**
 * Skill directory resolution — multi-source, order is priority (first-wins):
 *   1. <cwd>/.taco/skills       2. $TACO_HOME/skills       3. ~/.claude/skills
 *   4. ~/.pi/skills             5. <sidecar>/skills/builtin (fallback)
 * ⚠ Opposite semantics to agentDirs: skills dedupe by name (first-wins).
 */
export function defaultSkillDirs(cwd: string): SkillDirInput[] {
    return [
        { path: resolvePath(cwd, ".taco", "skills"), source: "user" },
        { path: resolvePath(tacoHome(), "skills"), source: "user" },
        { path: resolvePath(homedir(), ".claude", "skills"), source: "user" },
        { path: resolvePath(homedir(), ".pi", "skills"), source: "user" },
        {
            path: resolvePath(resourceRoot(), "skills", "builtin"),
            source: "builtin",
        },
    ];
}

/**
 * Default sessionsRoot resolution.
 *
 * Priority (later overrides earlier):
 *   1. Explicit override argument (already resolved)
 *   2. TACO_SESSIONS_ROOT env
 *   3. Derived from TACO_HOME env / $HOME → `~/.taco/sessions`
 *
 * Any relative path is resolved to absolute to prevent downstream absolute-path assumptions from breaking.
 */
export function defaultSessionsRoot(override?: string): string {
    if (override) return resolveAbsolute(override);
    if (process.env.TACO_SESSIONS_ROOT) return resolveAbsolute(process.env.TACO_SESSIONS_ROOT);
    return resolvePath(tacoHome(), "sessions");
}

// Process-local cache keyed by config path. The permission broker reads global
// config on every shell command; without this cache each shell call would hit
// disk synchronously. saveGlobalConfig invalidates it after a successful
// atomic rename. TACO_HOME changes (tests) produce a different path key, so
// cross-test leakage is impossible.
let globalConfigCache: { path: string; config: TacoGlobalConfigShape } | undefined;

/**
 * Read the global config with a process-level cache. Only a *successful* read
 * is cached — a failed read throws (see readJsonOrEmpty) and leaves the cache
 * untouched, so a transient read error is retried on the next call instead of
 * being frozen into the process for its whole lifetime.
 */
function loadGlobalConfig(): TacoGlobalConfigShape {
    const path = tacoGlobalConfigPath();
    if (globalConfigCache?.path === path) return globalConfigCache.config;
    const config = readJsonOrEmpty(path) as TacoGlobalConfigShape;
    globalConfigCache = { path, config };
    return config;
}

/**
 * Merge: cliOverrides > env vars > global config.
 *
 * Note: ANTHROPIC_API_KEY / OPENAI_API_KEY are read directly from env by pi-ai and
 * normally bypass resolveConfig. However, so that `injectApiKeysToEnv` can inject keys
 * from taco.json when they are not in env, we still preserve the top-level /
 * `apiKeys.*` paths.
 */
export function resolveConfig(
    cliOverrides: Partial<TacoGlobalConfigShape> = {},
): ResolvedTacoConfig {
    const global = loadGlobalConfig();

    return {
        defaultModel: cliOverrides.defaultModel ?? global.defaultModel,
        defaultProvider: cliOverrides.defaultProvider ?? global.defaultProvider,
        sessionsRoot: cliOverrides.sessionsRoot ?? global.sessionsRoot,
        systemPrompt: cliOverrides.systemPrompt ?? global.systemPrompt,
        defaultThinkingLevel:
            validateThinkingLevel(cliOverrides.thinkingLevel, "cli") ??
            validateThinkingLevel(global.thinkingLevel, "taco.json") ??
            undefined,
        // CLI overrides win over taco.json for the whole `instructions` block —
        // a partial CLI patch means "replace the user's config entirely". This
        // matches how `systemPrompt` is handled above (whole-block override)
        // and keeps the resolution model simple: one source-of-truth path, not
        // a per-key merge that could surprise users by silently flipping one
        // file's enable state under their feet.
        instructions: cliOverrides.instructions ?? global.instructions,
        apiKeys: {
            ...global.apiKeys,
            anthropic: cliOverrides.anthropicApiKey ?? global.anthropicApiKey ?? "",
            openai: cliOverrides.openaiApiKey ?? global.openaiApiKey ?? "",
            ...(cliOverrides.apiKeys ?? {}),
        },
        extensions: cliOverrides.extensions ?? global.extensions,
        disabledExtensions: cliOverrides.disabledExtensions ?? global.disabledExtensions,
        channels: (cliOverrides.channels ?? global.channels) as ChannelConfig[] | undefined,
        compaction: (() => {
            const cliCompaction = validateCompactionConfig(cliOverrides.compaction, "cli");
            const globalCompaction = validateCompactionConfig(global.compaction, "taco.json");
            return {
                enabled:
                    cliCompaction?.enabled ??
                    globalCompaction?.enabled ??
                    DEFAULT_COMPACTION_ENABLED,
                threshold:
                    cliCompaction?.threshold ??
                    globalCompaction?.threshold ??
                    DEFAULT_COMPACTION_THRESHOLD,
            };
        })(),
        customProviders: validateCustomProviders(global.customProviders, "taco.json"),
        mcpServers: validateMcpServers(global.mcpServers, "taco.json"),
        memoryEnabled: cliOverrides.memoryEnabled ?? global.memoryEnabled,
    };
}

const CUSTOM_PROVIDER_APIS: ReadonlyArray<CustomProviderApi> = [
    "chatcomplete",
    "response",
    "anthropic",
];

/**
 * Validate customProviders. Any invalid entry throws — the caller (settings.write
 * handler) turns the error into an invalid_value RPC response. Returns the
 * value as-is after validation (no normalisation); `source` is only used in error messages.
 */
export function validateCustomProviders(
    value: unknown,
    source: string,
): CustomProviderConfig[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`invalid customProviders from ${source}: must be an array`);
    }
    const seen = new Set<string>();
    const out: CustomProviderConfig[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object") {
            throw new Error(`invalid customProviders from ${source}: entry must be an object`);
        }
        const e = raw as Partial<CustomProviderConfig>;
        if (typeof e.id !== "string" || !e.id.startsWith(CUSTOM_PROVIDER_PREFIX)) {
            throw new Error(
                `invalid customProviders from ${source}: id must start with "${CUSTOM_PROVIDER_PREFIX}"`,
            );
        }
        if (seen.has(e.id)) {
            throw new Error(`invalid customProviders from ${source}: duplicate id ${e.id}`);
        }
        seen.add(e.id);
        if (typeof e.name !== "string" || e.name.trim() === "") {
            throw new Error(
                `invalid customProviders from ${source}: name must be a non-empty string (${e.id})`,
            );
        }
        if (
            typeof e.api !== "string" ||
            !CUSTOM_PROVIDER_APIS.includes(e.api as CustomProviderApi)
        ) {
            throw new Error(
                `invalid customProviders from ${source}: api must be one of ${CUSTOM_PROVIDER_APIS.join(" / ")} (${e.id})`,
            );
        }
        if (typeof e.baseUrl !== "string" || e.baseUrl.trim() === "") {
            throw new Error(
                `invalid customProviders from ${source}: baseUrl must be a non-empty string (${e.id})`,
            );
        }
        if (!Array.isArray(e.models) || e.models.length === 0) {
            throw new Error(
                `invalid customProviders from ${source}: models must be a non-empty array (${e.id})`,
            );
        }
        const models: CustomModelEntry[] = [];
        for (const m of e.models) {
            if (!m || typeof m !== "object" || typeof (m as CustomModelEntry).id !== "string") {
                throw new Error(
                    `invalid customProviders from ${source}: each model needs a string id (${e.id})`,
                );
            }
            models.push(m as CustomModelEntry);
        }
        out.push({
            id: e.id,
            name: e.name,
            api: e.api as CustomProviderApi,
            baseUrl: e.baseUrl,
            models,
        });
    }
    return out;
}

const MCP_TRANSPORT_KINDS: ReadonlySet<McpTransportKind> = new Set(["stdio", "http"]);
const MCP_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates mcpServers. Any invalid entry throws — the caller (settings.write
 * handler) turns the error into an invalid_value RPC response. Returns the
 * value as-is after validation (no normalization); `source` is only used in
 * error messages. Servers with `enabled: false` are still validated (config
 * is kept, only the runtime skips them).
 */
export function validateMcpServers(value: unknown, source: string): McpServerConfig[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(`invalid mcpServers from ${source}: must be an array`);
    }
    const seen = new Set<string>();
    const out: McpServerConfig[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== "object") {
            throw new Error(`invalid mcpServers from ${source}: entry must be an object`);
        }
        const e = raw as Partial<McpServerConfig>;
        if (typeof e.id !== "string" || !MCP_ID_PATTERN.test(e.id)) {
            throw new Error(`invalid mcpServers from ${source}: id must match ^[a-zA-Z0-9_-]+$`);
        }
        if (seen.has(e.id)) {
            throw new Error(`invalid mcpServers from ${source}: duplicate id ${e.id}`);
        }
        seen.add(e.id);
        if (
            typeof e.transport !== "string" ||
            !MCP_TRANSPORT_KINDS.has(e.transport as McpTransportKind)
        ) {
            throw new Error(
                `invalid mcpServers from ${source}: transport must be "stdio" or "http" (${e.id})`,
            );
        }
        if (e.transport === "stdio") {
            if (typeof e.command !== "string" || e.command.trim() === "") {
                throw new Error(
                    `invalid mcpServers from ${source}: stdio server needs a non-empty command (${e.id})`,
                );
            }
        } else {
            if (typeof e.url !== "string" || e.url.trim() === "") {
                throw new Error(
                    `invalid mcpServers from ${source}: http server needs a non-empty url (${e.id})`,
                );
            }
            try {
                new URL(e.url);
            } catch {
                throw new Error(
                    `invalid mcpServers from ${source}: url must be a valid URL (${e.id})`,
                );
            }
        }
        if (
            e.timeoutMs !== undefined &&
            (typeof e.timeoutMs !== "number" || !Number.isFinite(e.timeoutMs) || e.timeoutMs <= 0)
        ) {
            throw new Error(
                `invalid mcpServers from ${source}: timeoutMs must be a positive number (${e.id})`,
            );
        }
        if (
            e.alwaysLoaded !== undefined &&
            (!Array.isArray(e.alwaysLoaded) ||
                e.alwaysLoaded.some((n) => typeof n !== "string" || n.trim() === ""))
        ) {
            throw new Error(
                `invalid mcpServers from ${source}: alwaysLoaded must be a non-empty-string array (${e.id})`,
            );
        }
        out.push({
            id: e.id,
            transport: e.transport,
            ...(e.enabled !== undefined ? { enabled: e.enabled } : {}),
            ...(e.command !== undefined ? { command: e.command } : {}),
            ...(e.args !== undefined ? { args: e.args } : {}),
            ...(e.env !== undefined ? { env: e.env } : {}),
            ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
            ...(e.url !== undefined ? { url: e.url } : {}),
            ...(e.headers !== undefined ? { headers: e.headers } : {}),
            ...(e.timeoutMs !== undefined ? { timeoutMs: e.timeoutMs } : {}),
            ...(e.alwaysLoaded !== undefined ? { alwaysLoaded: e.alwaysLoaded } : {}),
        });
    }
    return out;
}

/** Read the current mcpServers array; empty when unset. */
export function readMcpServers(): McpServerConfig[] {
    return readGlobalConfig().mcpServers ?? [];
}

/**
 * Validate and normalize the `commandPermissions` field.
 *  - null/undefined returns the default { mode: "ask", rules: [] }
 *  - non-object / array throws (caller surfaces as invalid_value)
 *  - mode must be "ask" or "auto"; "bypass" is rejected at the config layer
 *  - rules are strings; object-shaped rules ({ kind, command }) are rejected
 *    with an error so the loader fails loud rather than silently dropping
 *    rules the user expected to apply.
 */
export function validateCommandPermissions(
    value: unknown,
    source: string,
): CommandPermissionConfig {
    if (value === undefined || value === null) return { mode: "ask", rules: [] };
    if (typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid commandPermissions from ${source}: expected object`);
    }
    const obj = value as Record<string, unknown>;
    const rawMode = obj.mode;
    const mode: CommandPermissionMode =
        typeof rawMode === "string" &&
        COMMAND_PERMISSION_MODES.has(rawMode as CommandPermissionMode)
            ? (rawMode as CommandPermissionMode)
            : "ask";
    const rules: CommandPermissionRule[] = [];
    if (Array.isArray(obj.rules)) {
        for (const [i, raw] of obj.rules.entries()) {
            if (typeof raw !== "string") {
                throw new Error(
                    `invalid commandPermissions from ${source}: rules[${i}] must be a string pattern ` +
                        "(legacy { kind, command } shape is no longer supported)",
                );
            }
            const result = validatePermissionRule(raw);
            if (result.valid) rules.push(result.canonical);
        }
    }
    return { mode, rules: Array.from(new Set(rules)) };
}

/**
 * Merge a patch into the on-disk taco.json using an atomic write (tmp file + rename).
 * Field whitelist + value-range validation prevents RPC clients from corrupting global config.
 *
 * Returns the latest view after writing (equivalent to `readGlobalConfig()`).
 *
 * `undefined` / `null` on known scalar fields means "clear" (set to `undefined`);
 * the `apiKeys` field uses shallow merge (only the provided keys are overwritten).
 */
export function saveGlobalConfig(patch: Partial<TacoGlobalConfigShape>): TacoGlobalConfigShape {
    if (!patch || typeof patch !== "object") {
        throw new Error("saveGlobalConfig: patch must be an object");
    }
    const path = tacoGlobalConfigPath();
    const current = readJsonOrEmpty(path) as TacoGlobalConfigShape;
    const next: TacoGlobalConfigShape = { ...current };

    if ("defaultModel" in patch) next.defaultModel = patch.defaultModel;
    if ("defaultProvider" in patch) next.defaultProvider = patch.defaultProvider;
    if ("sessionsRoot" in patch) next.sessionsRoot = patch.sessionsRoot;
    if ("systemPrompt" in patch) next.systemPrompt = patch.systemPrompt;
    if ("commandPermissions" in patch) {
        next.commandPermissions = validateCommandPermissions(patch.commandPermissions, "patch");
    }
    if ("anthropicApiKey" in patch) next.anthropicApiKey = patch.anthropicApiKey;
    if ("openaiApiKey" in patch) next.openaiApiKey = patch.openaiApiKey;
    if ("thinkingLevel" in patch) {
        if (patch.thinkingLevel === undefined || patch.thinkingLevel === null) {
            next.thinkingLevel = undefined;
        } else {
            next.thinkingLevel = validateThinkingLevel(patch.thinkingLevel, "patch");
        }
    }
    if (patch.apiKeys) {
        next.apiKeys = { ...(current.apiKeys ?? {}), ...patch.apiKeys };
    }
    if ("extensions" in patch) next.extensions = patch.extensions;
    if ("disabledExtensions" in patch) next.disabledExtensions = patch.disabledExtensions;
    if ("channels" in patch) next.channels = patch.channels;
    if ("customProviders" in patch) {
        // Whole-array replace (no merge). Validation failure throws → falls back to unwritten.
        next.customProviders = validateCustomProviders(patch.customProviders, "patch");
    }
    if ("mcpServers" in patch) {
        // Whole-array replace. Validation failure throws → falls back to unwritten.
        next.mcpServers = validateMcpServers(patch.mcpServers, "patch");
    }
    if ("compaction" in patch) {
        // Shallow merge — validates the merged shape (disk + patch) as a whole; failure throws → falls back to unwritten.
        const rawCurrent = (current.compaction ?? {}) as Partial<CompactionConfig>;
        const merged: Partial<CompactionConfig> = {
            enabled:
                patch.compaction?.enabled !== undefined
                    ? patch.compaction.enabled
                    : rawCurrent.enabled,
            threshold:
                patch.compaction?.threshold !== undefined
                    ? patch.compaction.threshold
                    : rawCurrent.threshold,
        };
        next.compaction = mergeCompactionPatch(
            // Validate the merged result via validateCompactionConfig
            {
                enabled: merged.enabled ?? DEFAULT_COMPACTION_ENABLED,
                threshold: merged.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
            },
            merged,
            "patch",
        );
    }
    if ("memoryEnabled" in patch) next.memoryEnabled = patch.memoryEnabled;
    if ("instructions" in patch) {
        // Nested merge — same semantics as `compaction` above. Per-file
        // switches and override paths are deep-merged so a partial patch
        // (e.g. only `{ files: { claudeMd: false } }`) flips only the named
        // leaves. Explicit `undefined` clears the whole block.
        if (patch.instructions === undefined) {
            next.instructions = undefined;
        } else {
            next.instructions = mergeInstructionsPatch(
                current.instructions,
                patch.instructions,
                "patch",
            );
        }
    }
    // Note: debugMode / theme and other client-only fields are not in TacoGlobalConfigShape,
    // so a patch with them is rejected at the TypeScript layer — no need to filter here,
    // avoiding a residual runtime slot for "client fields".

    // atomic rename: write to temp file in the same dir, fsync-friendly before rename.
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
    });
    restrictOwnerSync(tmp, 0o600);
    try {
        renameSync(tmp, path);
    } catch (e) {
        try {
            unlinkSync(tmp);
        } catch {
            // Ignore cleanup failure
        }
        throw e;
    }
    globalConfigCache = undefined;
    return next;
}

/** Exposes raw read for settings.get handler — behaviour equivalent to `loadGlobalConfig()`, exposed as a public API. */
export function readGlobalConfig(): TacoGlobalConfigShape {
    return loadGlobalConfig();
}

/**
 * Inject apiKeys into process.env (ANTHROPIC_API_KEY / OPENAI_API_KEY / others).
 * pi-ai reads these from env natively.
 * @returns Only the key-value pairs to inject; does not include existing process.env values.
 */
export function injectApiKeysToEnv(apiKeys: Record<string, string>): Record<string, string> {
    const patch: Record<string, string> = {};
    if (apiKeys.anthropic) patch.ANTHROPIC_API_KEY = apiKeys.anthropic;
    if (apiKeys.openai) patch.OPENAI_API_KEY = apiKeys.openai;
    for (const [provider, key] of Object.entries(apiKeys)) {
        if (provider === "anthropic" || provider === "openai") continue;
        if (!key) continue;
        const upper = provider.toUpperCase().replace(/-/g, "_");
        patch[`${upper}_API_KEY`] = key;
    }
    return patch;
}

function resolveAbsolute(p: string): string {
    return isAbsolute(p) ? p : resolvePath(p);
}

/**
 * Read a JSON config file. Missing file → `{}` (legitimately unconfigured).
 * Any read or parse failure throws — silently returning `{}` here poisons
 * `globalConfigCache` with an empty config for the process lifetime, which
 * makes the desktop settings panes (MCP / providers / channels) go blank
 * while the tools loaded at startup from the same file keep working.
 */
function readJsonOrEmpty(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {};
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
        log.error(`failed to read config ${path}:`, err);
        throw err;
    }
}
