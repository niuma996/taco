/**
 * Project-context instructions resolution.
 *
 * Reads CLAUDE.md / AGENTS.md / DESIGN.md from a workspace-relative directory
 * chain and returns a list of blocks ready to be wrapped as `<instructions>`
 * tags. Each file is resolved independently — missing one does not affect
 * the others.
 *
 * Priority chain (per file, first non-empty match wins):
 *   1. <cwd>/.taco/<name>.md              project taco config dir (project overrides)
 *   2. <cwd>/<name>.md                    project root
 *   3. $TACO_HOME/<name>.md               user taco global (~/.taco)
 *   4. ~/.claude/<name>.md                claude-compatible user dir (CLAUDE.md only)
 *
 * AGENTS.md / DESIGN.md skip step 4 — only Claude Code convention has the
 * `~/.claude/` mirror, and AGENTS.md / DESIGN.md are not part of that.
 *
 * When `filesOverride.<name>` is set, the lookup is skipped entirely and the
 * override path is read directly — useful for projects whose instructions
 * live under e.g. `docs/AGENTS.md`.
 *
 * All filesystem reads are isolated per file: a permission error on one
 * directory must not block reads from the others. Errors are surfaced via
 * `resolveInstructions.errors[]` so the caller can `log.warn` per file
 * without losing the rest of the resolution.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { InstructionsConfig } from "@taco-ai/protocol";
import { tacoHome } from "./tacoHome.ts";

/** Canonical file names; order matches the section comment above. */
export type InstructionFileName = "CLAUDE.md" | "AGENTS.md" | "DESIGN.md";

export const INSTRUCTION_FILE_NAMES: ReadonlyArray<InstructionFileName> = [
    "CLAUDE.md",
    "AGENTS.md",
    "DESIGN.md",
];

interface FileSwitchEntry {
    /** Config path that maps to this file's enable flag. */
    readonly key: "claudeMd" | "agentsMd" | "designMd";
    /** Default enable state when the user has not set the flag. */
    readonly defaultEnabled: boolean;
    /** Whether the file may be looked up in ~/.claude/ (Claude Code compat). */
    readonly checkClaudeHome: boolean;
}

const FILE_SWITCH_TABLE: Record<InstructionFileName, FileSwitchEntry> = {
    "CLAUDE.md": { key: "claudeMd", defaultEnabled: true, checkClaudeHome: true },
    "AGENTS.md": { key: "agentsMd", defaultEnabled: true, checkClaudeHome: false },
    "DESIGN.md": { key: "designMd", defaultEnabled: false, checkClaudeHome: false },
};

/** Default config — applied when the user has not set anything.
 *  Note: per-file defaults must match `FILE_SWITCH_TABLE[name].defaultEnabled`
 *  (CLAUDE.md / AGENTS.md enabled, DESIGN.md opt-in) so a missing flag and
 *  a `null` config resolve to the same outcome. */
export const DEFAULT_INSTRUCTIONS_CONFIG: Required<InstructionsConfig> = {
    enabled: true,
    files: { claudeMd: true, agentsMd: true, designMd: false },
    filesOverride: {},
    inheritToSubagents: true,
};

/** One resolved file — content + a path hint for the `<instructions>` source
 *  attribute. The hint is a relative label, not an absolute path, so the
 *  prompt does not leak the host filesystem layout. */
export type InstructionSource =
    | "project-taco"
    | "project"
    | "user-taco"
    | "user-claude"
    | "override";

export interface InstructionBlock {
    readonly name: InstructionFileName;
    readonly source: InstructionSource;
    readonly content: string;
}

/**
 * Render one resolved block to the `<instructions source="…">…</instructions>`
 * XML the context hook and the subagent system-prompt appendix both use.
 *
 * Content is NOT escaped: it is markdown that may legitimately contain `<`,
 * `>`, and code fences. The only structural risk is a literal `</instructions>`
 * inside the file, which would close the tag early — we accept this because
 * (a) instructions files are trusted project content, (b) full escaping would
 * break the prompt's markdown rendering. The attribute value is escapeAttr'd
 * by construction since `source` is a fixed literal union (no user input).
 */
export function renderInstructionBlock(block: InstructionBlock): string {
    return `<instructions source="${block.source}">\n${block.content}\n</instructions>`;
}

/** Result of resolving a workspace's instructions against a config. */
export interface InstructionsResolution {
    /** Whether instructions should be injected at all. */
    readonly enabled: boolean;
    /** Resolved blocks in injection order (priority order). */
    readonly blocks: ReadonlyArray<InstructionBlock>;
    /** Files that the user wanted to load but failed to read. The hook
     *  consumer can decide whether to log.warn or stay silent. */
    readonly errors: ReadonlyArray<{ name: InstructionFileName; message: string }>;
}

export interface ResolveInstructionsOptions {
    /** Workspace cwd. */
    cwd: string;
    /** User config; merged with defaults inside this function. */
    config?: InstructionsConfig;
}

/**
 * Resolve all enabled instruction files against the priority chain. Returns
 * a `InstructionsResolution` whose `blocks` is the list of files that were
 * actually loaded (empty when nothing matched). Pure function — does not
 * mutate `config` or read disk beyond the readFile calls below.
 */
export function resolveInstructions(opts: ResolveInstructionsOptions): InstructionsResolution {
    const config = mergeWithDefaults(opts.config);

    if (!config.enabled) {
        return { enabled: false, blocks: [], errors: [] };
    }

    const blocks: InstructionBlock[] = [];
    const errors: { name: InstructionFileName; message: string }[] = [];

    for (const name of INSTRUCTION_FILE_NAMES) {
        const entry = FILE_SWITCH_TABLE[name];
        // Default-resolve to the documented per-file default when the user
        // has not set the flag explicitly. A patch that only names one file
        // must not accidentally flip the others.
        const enabled = config.files[entry.key] ?? entry.defaultEnabled;
        if (!enabled) continue;

        const overridePath = config.filesOverride[entry.key];
        let result: InstructionBlock | undefined | { error: string };
        if (overridePath) {
            // Override paths are explicit user intent — a missing file is
            // a real error (typo / wrong path), not the same as "no
            // instructions file in the chain". Surface it so the hook
            // consumer can `log.warn` instead of silently dropping the file.
            result = readInstructionsFromPath(overridePath, "override", name);
            if (result === undefined) {
                errors.push({
                    name,
                    message: `override path not found: ${overridePath}`,
                });
                continue;
            }
        } else {
            result = readInstructionsFromChain(name, opts.cwd, entry.checkClaudeHome);
            if (result === undefined) continue; // not found anywhere
        }
        if ("error" in result) {
            errors.push({ name, message: result.error });
            continue;
        }
        blocks.push(result);
    }

    return { enabled: true, blocks, errors };
}

function readInstructionsFromChain(
    name: InstructionFileName,
    cwd: string,
    checkClaudeHome: boolean,
): InstructionBlock | undefined | { error: string } {
    const chain: Array<{ dir: string; label: InstructionSource }> = [
        { dir: resolvePath(cwd, ".taco"), label: "project-taco" },
        { dir: cwd, label: "project" },
        { dir: tacoHome(), label: "user-taco" },
    ];
    if (checkClaudeHome) {
        chain.push({ dir: resolvePath(homedir(), ".claude"), label: "user-claude" });
    }

    let lastError = "";
    for (const { dir, label } of chain) {
        const result = readInstructionsFromPath(resolvePath(dir, name), label, name);
        if (result === undefined) continue; // not present here, try next
        if ("error" in result) {
            // Stash the most informative error so the caller can warn once
            // rather than burying the failure under a "file not found".
            lastError = `${label}: ${result.error}`;
            continue;
        }
        return result;
    }
    if (lastError) return { error: lastError };
    return undefined; // missing everywhere — silent skip
}

function readInstructionsFromPath(
    filePath: string,
    source: InstructionSource,
    name: InstructionFileName,
): InstructionBlock | undefined | { error: string } {
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return undefined; // missing — try next or skip
        const msg = e instanceof Error ? e.message : String(e);
        return { error: `${code ?? "error"} reading ${filePath}: ${msg}` };
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined; // empty file is treated as missing
    return { name, source, content: trimmed };
}

/** Apply defaults without mutating the input. */
function mergeWithDefaults(config?: InstructionsConfig): Required<InstructionsConfig> {
    return {
        enabled: config?.enabled ?? DEFAULT_INSTRUCTIONS_CONFIG.enabled,
        files: {
            claudeMd: config?.files?.claudeMd ?? DEFAULT_INSTRUCTIONS_CONFIG.files.claudeMd,
            agentsMd: config?.files?.agentsMd ?? DEFAULT_INSTRUCTIONS_CONFIG.files.agentsMd,
            designMd: config?.files?.designMd ?? DEFAULT_INSTRUCTIONS_CONFIG.files.designMd,
        },
        filesOverride: {
            claudeMd: config?.filesOverride?.claudeMd,
            agentsMd: config?.filesOverride?.agentsMd,
            designMd: config?.filesOverride?.designMd,
        },
        inheritToSubagents:
            config?.inheritToSubagents ?? DEFAULT_INSTRUCTIONS_CONFIG.inheritToSubagents,
    };
}
