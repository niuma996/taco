/**
 * Project-context instructions resolution — reads CLAUDE.md / AGENTS.md /
 * DESIGN.md from a workspace-relative chain into `<instructions>` blocks.
 * Each file resolves independently; one missing file does not affect others.
 *
 * Priority chain per file (first non-empty match wins): `<cwd>/.taco/<name>.md`
 * (project overrides) → `<cwd>/<name>.md` (project root) →
 * `$TACO_HOME/<name>.md` (user global) → `~/.claude/<name>.md` (CLAUDE.md only).
 *
 * `filesOverride.<name>` skips the lookup and reads that path directly. Reads
 * are isolated per file — one directory's permission error cannot block the
 * others — and failures land in `resolveInstructions.errors[]`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type { InstructionsConfig } from "@taco-ai/protocol";
import { escapeTagText } from "../tags/builder.ts";
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
 * The body is escaped so file content cannot close this tag early or forge a
 * sibling context tag; the attribute value is escapeAttr'd by construction
 * since `source` is a fixed literal union. A cloned repository's instruction
 * file is attacker-influenced content, so the body is treated as data rather
 * than trusted markup.
 */
export function renderInstructionBlock(block: InstructionBlock): string {
    return `<instructions source="${block.source}">\n${instructionBody(block.content)}\n</instructions>`;
}

/** The escaped instruction body: the representation inside the tag and therefore
 *  also the representation a dedup key must compare, since the hook reads keys
 *  back out of an already-rendered window. */
export function instructionBody(content: string): string {
    return escapeTagText(content);
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
