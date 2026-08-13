/**
 * `projectContextForPrompt` — render the `<project_context>` block from a
 * workspace's `.gitignore`, truncated to a safe budget.
 *
 * Goals:
 *
 *   - Give the model a denylist so it knows which paths to *avoid*
 *     when proposing grep/glob/read targets. The tools already honour
 *     `.gitignore` for filtering results, but the model still spends tokens
 *     describing searches that hit nothing. A denylist in the system prompt
 *     cuts that wasted effort.
 *   - Truncate conservatively (per-line, 2000 chars by default) so a
 *     multi-megabyte monorepo `.gitignore` does not blow the prompt budget.
 *   - Return `""` when there is no `.gitignore` or it is empty — the caller
 *     treats an empty string as "no contributor needed" and skips the splice.
 *
 * The truncation is **per line**: we accumulate whole lines until adding the
 * next line would exceed the budget. A line that pushes us over is dropped
 * (a partial ignore directive is worse than no directive at all — silently
 * dropping one is recoverable, silently including half of one is not).
 */

import { readFileSync } from "node:fs";

export interface ProjectContextOptions {
    /** Absolute path to the workspace root. */
    cwd: string;
    /** Hard cap on the rendered block. Defaults to 2000 chars. */
    maxChars?: number;
    /**
     * When true, omit the `Working directory:` line from the rendered block.
     * Used for IM/third-party channels where the absolute workspace path should
     * not reach the remote platform. The `.gitignore` denylist is still included
     * because it is not sensitive.
     */
    hideCwd?: boolean;
}

export const DEFAULT_PROJECT_CONTEXT_MAX_CHARS = 2000;

/**
 * Read `.gitignore` at `cwd` and return the `<project_context>` block.
 * Returns `""` when the file is missing or empty — the caller treats that as
 * "skip the contributor". Errors other than ENOENT bubble up; the workspace
 * constructor wraps this call in try/catch and downgrades any read failure to
 * a `log.warn` so a permission issue or symlink loop never blocks startup.
 */
export function projectContextForPrompt(options: ProjectContextOptions): string {
    const { cwd, maxChars = DEFAULT_PROJECT_CONTEXT_MAX_CHARS, hideCwd } = options;

    let raw: string;
    try {
        raw = readFileSync(`${cwd}/.gitignore`, "utf8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw e;
    }

    const truncated = truncateByLines(raw, maxChars);
    if (truncated.length === 0) return "";

    const lines = ["<project_context>"];
    if (!hideCwd) {
        lines.push(`Working directory: ${cwd}`);
        lines.push("");
    }
    lines.push(
        "The following paths are excluded from the repository by .gitignore.",
        "Avoid grep / glob / read on these paths unless the user explicitly",
        "asks for them — the tools already filter results, so searching them",
        "wastes tokens.",
        "",
        `.gitignore (truncated by lines to ${String(maxChars)} chars):`,
        "```",
        truncated,
        "```",
        "</project_context>",
    );
    return lines.join("\n");
}

/**
 * Keep the longest prefix of `text` that ends on a line boundary and fits
 * within `maxChars`. The returned string has **no trailing newline** so the
 * caller can wrap it in fences without doubling the boundary marker.
 * Exported for tests.
 */
export function truncateByLines(text: string, maxChars: number): string {
    if (text.length <= maxChars) return stripTrailingNewline(text);
    // Walk line boundaries. The budget is on the *content* — the block
    // wrapper adds another ~300 chars of framing.
    const lines = text.split("\n");
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
        // +1 for the newline we'd add between lines (or a trailing newline).
        const cost = line.length + 1;
        if (used + cost > maxChars) break;
        kept.push(line);
        used += cost;
    }
    return kept.join("\n");
}

function stripTrailingNewline(text: string): string {
    return text.endsWith("\n") ? text.slice(0, -1) : text;
}
