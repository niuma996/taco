/**
 * Agent loader: builtin agents from `builtinDir` (caller-provided, test-overridable)
 * plus user-defined agents from `userDirs`. Merge rule: load builtins first,
 * then user agents overwrite by `agentType` (same name → user wins).
 * Frontmatter parsed via gray-matter; files without a frontmatter `name` are skipped.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import type { AgentDefinition, AgentFewShot, SubagentContextMode } from "./types.ts";

interface AgentFrontmatter {
    name?: string;
    description?: string;
    whenToUse?: string;
    tools?: unknown;
    maxTurns?: unknown;
    fewShots?: unknown;
    context?: unknown;
    [key: string]: unknown;
}

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
    return {
        agentType: name,
        description: typeof frontmatter.description === "string" ? frontmatter.description : "",
        whenToUse: typeof frontmatter.whenToUse === "string" ? frontmatter.whenToUse : undefined,
        systemPrompt: body,
        tools,
        maxTurns: Number.isFinite(maxTurns) ? maxTurns : undefined,
        fewShots: parseFewShots(frontmatter.fewShots),
        context: parseContext(frontmatter.context),
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

async function loadDir(dir: string, source: "builtin" | "user"): Promise<AgentDefinition[]> {
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
    for (const def of await loadDir(opts.builtinDir, "builtin")) {
        byType.set(def.agentType, def);
    }
    for (const dir of opts.userDirs) {
        for (const def of await loadDir(dir, "user")) {
            byType.set(def.agentType, def); // user overrides builtin
        }
    }
    return [...byType.values()];
}
