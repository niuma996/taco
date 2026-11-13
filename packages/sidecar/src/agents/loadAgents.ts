/**
 * Agent loader: builtin agents from `builtinDir` (caller-provided, test-overridable)
 * plus user-defined agents from `userDirs`. Merge rule: load builtins first,
 * then user agents overwrite by `agentType` (same name → user wins).
 * Frontmatter parsed via gray-matter; files without a frontmatter `name` are skipped.
 */

import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import matter from "gray-matter";
import type {
    AgentDefinition,
    AgentFewShot,
    ClaudeCodePermissionMode,
    CodexAgentConfig,
    CodexApprovalPolicy,
    CodexSandboxMode,
    SubagentContextMode,
    SubagentRuntime,
} from "./types.ts";

interface AgentFrontmatter {
    name?: string;
    description?: string;
    whenToUse?: string;
    tools?: unknown;
    maxTurns?: unknown;
    timeoutMinutes?: unknown;
    fewShots?: unknown;
    context?: unknown;
    runtime?: unknown;
    permissionMode?: unknown;
    cwd?: unknown;
    codex?: unknown;
    [key: string]: unknown;
}

/**
 * Largest values a definition may declare. The protocol schema, the desktop
 * form and this parser share them, so the same agent means the same thing
 * however it was written.
 */
export const MAX_AGENT_TURNS = 500;
export const MAX_AGENT_TIMEOUT_MINUTES = 600;

/** Split frontmatter; when missing, returns frontmatter={} body=full text. */
function splitFrontmatter(content: string): { frontmatter: AgentFrontmatter; body: string } {
    const parsed = matter(content);
    return {
        frontmatter: (parsed.data ?? {}) as AgentFrontmatter,
        body: (parsed.content ?? "").trim(),
    };
}

/** Parse one .md into an AgentDefinition; returns null when `name` is missing. */
export function parseAgentMarkdown(
    content: string,
    filePath: string,
    source: "builtin" | "user",
): AgentDefinition | null {
    const { frontmatter, body } = splitFrontmatter(content);
    const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
    if (!name) return null;
    const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools.map(String) : undefined;
    const maxTurns =
        typeof frontmatter.maxTurns === "number"
            ? frontmatter.maxTurns
            : typeof frontmatter.maxTurns === "string"
              ? Number.parseInt(frontmatter.maxTurns, 10)
              : undefined;
    const timeoutMinutes =
        typeof frontmatter.timeoutMinutes === "number"
            ? frontmatter.timeoutMinutes
            : typeof frontmatter.timeoutMinutes === "string"
              ? Number.parseFloat(frontmatter.timeoutMinutes)
              : undefined;
    return {
        agentType: name,
        description: typeof frontmatter.description === "string" ? frontmatter.description : "",
        whenToUse: typeof frontmatter.whenToUse === "string" ? frontmatter.whenToUse : undefined,
        systemPrompt: body,
        tools,
        // Capped like the RPC path: a hand-written file must not be able to
        // declare a budget the editor could not write.
        maxTurns:
            maxTurns !== undefined && Number.isFinite(maxTurns) && maxTurns > 0
                ? Math.min(Math.trunc(maxTurns), MAX_AGENT_TURNS)
                : undefined,
        timeoutMinutes:
            timeoutMinutes !== undefined && Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
                ? Math.min(Math.trunc(timeoutMinutes), MAX_AGENT_TIMEOUT_MINUTES)
                : undefined,
        fewShots: parseFewShots(frontmatter.fewShots),
        context: parseContext(frontmatter.context),
        runtime: parseRuntime(frontmatter.runtime),
        permissionMode: parsePermissionMode(frontmatter.permissionMode),
        cwd: parseCwd(frontmatter.cwd),
        codex: parseCodexConfig(frontmatter.codex),
        source,
        filePath,
    };
}

/**
 * Validate and normalise the optional `fewShots:` frontmatter entry.
 *
 * Accepts a YAML list of `{ user, assistant }` objects. Each field can be a
 * scalar or a block string (`|`); the parser strips indentation for the
 * block form already, so we only need to coerce. Items missing one of the
 * two strings are dropped — a malformed example is worse than no example,
 * because the model may mirror its incomplete shape.
 */
function parseFewShots(raw: unknown): ReadonlyArray<AgentFewShot> | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const out: AgentFewShot[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const user = (item as { user?: unknown }).user;
        const assistant = (item as { assistant?: unknown }).assistant;
        if (typeof user !== "string" || typeof assistant !== "string") continue;
        const userText = user.trim();
        const assistantText = assistant.trim();
        if (userText.length === 0 || assistantText.length === 0) continue;
        out.push({ user: userText, assistant: assistantText });
    }
    return out.length > 0 ? out : undefined;
}

/**
 * Validate the optional `context:` frontmatter entry. Only "independent" and
 * "fork" are legal; anything else (including omitted) yields undefined so the
 * caller defaults to "independent". Mirrors maxTurns' lenient style — a bad
 * value must not abort the whole agent load.
 */
function parseContext(raw: unknown): SubagentContextMode | undefined {
    if (raw === "independent" || raw === "fork") return raw;
    return undefined;
}

/** Validate the optional `runtime:` entry; absent or unknown = the default (`standard`). */
function parseRuntime(raw: unknown): SubagentRuntime | undefined {
    if (raw === "standard" || raw === "claude-code" || raw === "codex") return raw;
    return undefined;
}

const CODEX_SANDBOX_MODES: ReadonlySet<string> = new Set<CodexSandboxMode>([
    "read-only",
    "workspace-write",
    "danger-full-access",
]);

const CODEX_APPROVAL_POLICIES: ReadonlySet<string> = new Set<CodexApprovalPolicy>([
    "untrusted",
    "on-failure",
    "on-request",
    "never",
]);

function nonEmptyString(raw: unknown, maxLength: number): string | undefined {
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

/**
 * Validate the optional `codex:` frontmatter block. Mirrors the other
 * frontmatter parsers' lenient style: individual bad values are dropped, a
 * block whose every value is invalid (or which is not a mapping at all)
 * yields undefined, so a hand-written file can never fail the whole load.
 */
function parseCodexConfig(raw: unknown): CodexAgentConfig | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    // The model is an override, not a requirement: an agent without one
    // inherits the user's own Codex configuration.
    const model = nonEmptyString(record.model, 256);
    const config: CodexAgentConfig = {};
    if (model !== undefined) config.model = model;
    const cwd = parseCwd(record.cwd);
    if (cwd !== undefined) config.cwd = cwd;
    if (typeof record.sandbox === "string" && CODEX_SANDBOX_MODES.has(record.sandbox)) {
        config.sandbox = record.sandbox as CodexSandboxMode;
    }
    if (
        typeof record.approvalPolicy === "string" &&
        CODEX_APPROVAL_POLICIES.has(record.approvalPolicy)
    ) {
        config.approvalPolicy = record.approvalPolicy as CodexApprovalPolicy;
    }
    return Object.keys(config).length > 0 ? config : undefined;
}

const PERMISSION_MODES: ReadonlySet<string> = new Set<ClaudeCodePermissionMode>([
    "auto",
    "default",
    "acceptEdits",
    "plan",
    "dontAsk",
    "bypassPermissions",
    "inherit",
]);

/** Validate the optional `permissionMode:` entry; absent or unknown = the default (`auto`). */
function parsePermissionMode(raw: unknown): ClaudeCodePermissionMode | undefined {
    return typeof raw === "string" && PERMISSION_MODES.has(raw)
        ? (raw as ClaudeCodePermissionMode)
        : undefined;
}

/**
 * Validate the optional `cwd:` entry. Only an absolute path counts: a relative
 * one would resolve against whichever process happens to read it, and the
 * spawner falls back to the workspace directory for anything else.
 */
function parseCwd(raw: unknown): string | undefined {
    return typeof raw === "string" && isAbsolute(raw.trim()) ? raw.trim() : undefined;
}

export async function loadAgentDir(
    dir: string,
    source: "builtin" | "user",
): Promise<AgentDefinition[]> {
    let files: string[];
    try {
        files = await readdir(dir);
    } catch {
        return []; // directory missing → empty (user dir is optional)
    }
    const out: AgentDefinition[] = [];
    for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const filePath = join(dir, f);
        try {
            const content = await readFile(filePath, "utf-8");
            const def = parseAgentMarkdown(content, filePath, source);
            if (def) out.push(def);
        } catch {
            // A single failed file does not abort the load; parseAgentMarkdown
            // silently drops .md files with a missing `name`.
        }
    }
    return out;
}

export interface LoadAgentsOptions {
    /** Builtin agent directory. Production code passes the source builtin dir; tests may pass a temp dir. */
    builtinDir: string;
    /** User-defined directories (may be empty). Missing directories are silently ignored. */
    userDirs: string[];
}

/**
 * Load all agents: builtin → user. Returns a list deduplicated by
 * `agentType`; same-name user agents overwrite builtins. `builtinDir` is
 * provided by the caller (production: src/agents/builtin via import.meta.dirname;
 * tests may pass a temp dir).
 */
export async function loadAgents(opts: LoadAgentsOptions): Promise<AgentDefinition[]> {
    const byType = new Map<string, AgentDefinition>();
    for (const def of await loadAgentDir(opts.builtinDir, "builtin")) {
        byType.set(def.agentType, def);
    }
    for (const dir of opts.userDirs) {
        for (const def of await loadAgentDir(dir, "user")) {
            byType.set(def.agentType, def); // user overrides builtin
        }
    }
    return [...byType.values()];
}
