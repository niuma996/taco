/**
 * grep tool — search file contents and emit `relpath:line: text`.
 * Prefers system ripgrep (rg); falls back to fast-glob + per-file regex.
 * Both paths:
 *   - Honor .gitignore (`ignore` package) + safe defaults
 *   - Emit identical output format
 * Results truncated by line count (MAX_LINES).
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import fg from "fast-glob";
import ignore from "ignore";
import type { Static } from "typebox";
import { Type } from "typebox";
import { BASE_SAFE_DEFAULT_IGNORES } from "./safeDefaults.ts";

export type GrepTool = AgentHarnessTool<ExecutionToolContext>;

const MAX_LINES = 300;

const SAFE_DEFAULT_IGNORES = BASE_SAFE_DEFAULT_IGNORES;

const grepSchema = Type.Object({
    pattern: Type.String({ description: "Regex or literal string to search for." }),
    path: Type.Optional(
        Type.String({
            description:
                "Root directory to search in (relative to cwd or absolute). Defaults to cwd.",
        }),
    ),
    glob: Type.Optional(
        Type.String({
            description: "Filename filter in gitignore-style glob, e.g. '*.ts' or 'src/**/*.js'.",
        }),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match." })),
});

export type GrepToolInput = Static<typeof grepSchema>;

/** Probe whether rg is on PATH (process-lifetime cache). */
let rgAvailable: boolean | null = null;
function hasRipgrep(): boolean {
    if (rgAvailable !== null) return rgAvailable;
    try {
        const r = spawnSync("rg", ["--version"], { stdio: "ignore" });
        rgAvailable = r.status === 0;
    } catch {
        rgAvailable = false;
    }
    return rgAvailable;
}

/**
 * Parse root/.gitignore into an ignore filter. Returns null on failure.
 */
async function loadIgnoreFilter(
    env: ExecutionToolContext["env"],
    root: string,
    signal: AbortSignal | undefined,
): Promise<((rel: string) => boolean) | null> {
    const result = await env.readTextFile(`${root}/.gitignore`, signal);
    if (!result.ok) return null;
    const ig = ignore().add(result.value);
    // Coerce any absolute fast-glob result back to root-relative before
    // handing to `ignore`, and swallow the validation throw that the
    // `ignore` package raises for non-relative paths — better to surface
    // the match than fail the whole grep.
    return (m) => {
        const rel = isAbsolute(m) ? relative(root, m) : m;
        try {
            return ig.ignores(rel);
        } catch {
            return false;
        }
    };
}

/**
 * Build ripgrep's --ignore-file content (SAFE_DEFAULT_IGNORES + user's
 * .gitignore). rg itself does not support reading ignore-file from stdin so we
 * fall back to no filtering if stdin is unavailable.
 */
async function buildRipgrepIgnoreContent(
    env: ExecutionToolContext["env"],
    root: string,
    signal?: AbortSignal,
): Promise<string> {
    const lines = [...SAFE_DEFAULT_IGNORES];
    const result = await env.readTextFile(`${root}/.gitignore`, signal);
    if (result.ok) {
        lines.push(result.value);
    }
    return lines.join("\n");
}

async function runRipgrep(
    root: string,
    params: GrepToolInput,
    ignoreContent: string,
): Promise<string[]> {
    const args = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--no-ignore",
        "--hidden",
        "--ignore-file",
        "/dev/stdin",
    ];
    if (params.ignoreCase) args.push("--ignore-case");
    if (params.glob) args.push("--glob", params.glob);
    args.push(params.pattern, ".");
    const r = spawnSync("rg", args, {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
        input: ignoreContent,
    });
    if (r.status !== null && r.status > 1) throw new Error(r.stderr || "ripgrep failed");
    return (r.stdout ?? "").split("\n").filter((l) => l.length > 0);
}

async function runFallback(
    env: ExecutionToolContext["env"],
    root: string,
    params: GrepToolInput,
    signal: AbortSignal | undefined,
): Promise<string[]> {
    const ig = await loadIgnoreFilter(env, root, signal);
    const re = new RegExp(params.pattern, params.ignoreCase ? "i" : "");

    let files = fg.sync(params.glob ?? "**/*", {
        cwd: root,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: SAFE_DEFAULT_IGNORES,
    });
    if (ig) files = files.filter((rel) => !ig(rel));

    const out: string[] = [];
    for (const rel of files) {
        const absPath = resolve(root, rel);
        const textResult = await env.readTextFile(absPath, signal);
        if (!textResult.ok) continue; // binary / unreadable — skip
        if (signal?.aborted) throw new Error("Operation aborted");
        const lines = textResult.value.split("\n");
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${lines[i]}`);
        }
    }
    return out;
}

export function createGrepTool(): GrepTool {
    return {
        name: "grep",
        label: "grep",
        description:
            "Search file contents by regex or literal string. Respects .gitignore and excludes safe defaults (node_modules/.git/dist/build/.next). Returns matching 'file:line: text' rows, up to 300 lines.",
        parameters: grepSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Regex / literal search across files — the tool for finding *where* a symbol or string appears; use `glob` to find files by name instead. Honours .gitignore and skips node_modules/.git/dist/build/.next. Returns up to 300 `file:line: text` rows — if you hit the cap, narrow the pattern. Safe to issue in parallel in the same turn.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: GrepToolInput,
            signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            { env }: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: { count: number; truncated: boolean } }> {
            const cwdResult = await env.absolutePath(params.path ?? ".", signal);
            const root = getOrThrow(cwdResult);
            const ignoreContent = await buildRipgrepIgnoreContent(env, root, signal);

            const rawLines = hasRipgrep()
                ? await runRipgrep(root, params, ignoreContent)
                : await runFallback(env, root, params, signal);

            if (signal?.aborted) throw new Error("Operation aborted");
            const truncated = rawLines.length > MAX_LINES;
            const shown = truncated ? rawLines.slice(0, MAX_LINES) : rawLines;
            const body =
                shown.length === 0
                    ? "(no matches)"
                    : shown.join("\n") +
                      (truncated ? `\n… (${rawLines.length - MAX_LINES} more)` : "");
            return {
                content: [{ type: "text", text: body }],
                details: { count: rawLines.length, truncated },
            };
        },
    };
}
