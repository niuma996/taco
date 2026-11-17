/**
 * grep tool — search file contents and emit `relpath:line: text`.
 * Prefers system ripgrep (rg); falls back to fast-glob + per-file regex.
 * Both paths:
 *   - Honor .gitignore (`ignore` package) + safe defaults
 *   - Emit identical output format
 * Results truncated by line count (MAX_LINES), per-line length (MAX_LINE_CHARS)
 * and total size (MAX_OUTPUT_CHARS). A line cap alone is not a size cap: a few
 * hundred minified or jsonl rows can run to hundreds of KB, and one parallel
 * batch of those overflows the context window past what compaction can cut.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { Static } from "typebox";
import { Type } from "typebox";
import { HIDDEN_WINDOWS_SPAWN } from "../lib/hiddenWindowsSpawn.ts";
import { scrubbedProcessEnv } from "../runtime/models/providerKeyStore.ts";
import type {
    AgentHarnessTool,
    Context,
    ExecutionToolContext,
    TextContent,
} from "../runtime/pi/types.ts";
import { getOrThrow } from "../runtime/pi/values.ts";
import { BASE_SAFE_DEFAULT_IGNORES } from "./safeDefaults.ts";

export type GrepTool = AgentHarnessTool<ExecutionToolContext>;

const MAX_LINES = 300;
const MAX_LINE_CHARS = 500;
const MAX_OUTPUT_CHARS = 50_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface SearchResult {
    lines: string[];
    count: number;
    size: number;
    clipped: boolean;
    skippedLarge: number;
}

function searchResult(): SearchResult {
    return { lines: [], count: 0, size: 0, clipped: false, skippedLarge: 0 };
}

/** Count every match, but retain only the bounded display text. */
function appendMatch(result: SearchResult, raw: string): void {
    result.count++;
    if (result.lines.length >= MAX_LINES) return;
    const line = clipLine(raw);
    if (line !== raw) result.clipped = true;
    if (result.size + line.length + 1 > MAX_OUTPUT_CHARS) return;
    result.lines.push(line);
    result.size += line.length + 1;
}

function searchPattern(params: GrepToolInput): string {
    return params.glob && !params.glob.includes("/")
        ? `**/${params.glob}`
        : (params.glob ?? "**/*");
}

function clipLine(line: string): string {
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line clipped]` : line;
}

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
        const r = spawnSync("rg", ["--version"], {
            stdio: "ignore",
            env: scrubbedProcessEnv(),
            ...HIDDEN_WINDOWS_SPAWN,
        });
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
    piContext: Context,
): Promise<((rel: string) => boolean) | null> {
    const result = await env.readTextFile(`${root}/.gitignore`, piContext);
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

/** Build ripgrep's ignore file from safe defaults and the root's .gitignore. */
async function buildRipgrepIgnoreContent(
    env: ExecutionToolContext["env"],
    root: string,
    piContext: Context,
): Promise<string> {
    const lines = [...SAFE_DEFAULT_IGNORES];
    const result = await env.readTextFile(`${root}/.gitignore`, piContext);
    if (result.ok) {
        lines.push(result.value);
    }
    return lines.join("\n");
}

async function runRipgrep(
    root: string,
    params: GrepToolInput,
    ignoreContent: string,
    piContext: Context,
): Promise<SearchResult> {
    const tempDir = await mkdtemp(join(tmpdir(), "taco-grep-ignore-"));
    try {
        const ignorePath = join(tempDir, "ignore");
        await writeFile(ignorePath, ignoreContent, { mode: 0o600 });
        const args = [
            "--line-number",
            // Match end anchors before CRLF as the fallback does, on every host.
            "--crlf",
            "--no-heading",
            "--color",
            "never",
            "--no-ignore",
            "--hidden",
            "--ignore-file",
            ignorePath,
            "--max-columns",
            String(MAX_LINE_CHARS),
            "--max-columns-preview",
        ];
        if (params.ignoreCase) args.push("--ignore-case");
        if (params.glob) args.push("--glob", params.glob);
        // ripgrep prints `src\a.ts` on Windows; the tool contract (and the
        // fallback path) report forward slashes, so pin the separator. POSIX
        // already defaults to "/", so this only changes Windows output.
        if (process.platform === "win32") args.push("--path-separator=/");
        args.push("--", params.pattern, ".");
        const result = searchResult();
        const child = spawn("rg", args, {
            cwd: root,
            signal: piContext.abortSignal,
            env: scrubbedProcessEnv(),
            ...HIDDEN_WINDOWS_SPAWN,
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk.slice(0, 8_192 - stderr.length);
        });
        const completion = new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => {
                if (code === null || code > 1) {
                    reject(new Error(stderr || `ripgrep failed${signal ? ` (${signal})` : ""}`));
                } else {
                    resolve();
                }
            });
        });
        child.stdout.setEncoding("utf8");
        try {
            const consume = async (): Promise<void> => {
                let line = "";
                for await (const chunk of child.stdout) {
                    const text = String(chunk);
                    let start = 0;
                    while (start < text.length) {
                        const newline = text.indexOf("\n", start);
                        const end = newline === -1 ? text.length : newline;
                        // Keep one extra character to detect clipping without buffering long records.
                        line += text.slice(
                            start,
                            Math.min(end, start + MAX_LINE_CHARS + 1 - line.length),
                        );
                        if (newline === -1) break;
                        if (line.length > 0) appendMatch(result, line);
                        line = "";
                        start = newline + 1;
                    }
                }
                if (line.length > 0) appendMatch(result, line);
            };
            await Promise.all([completion, consume()]);
        } finally {
            child.stdout.destroy();
            if (child.exitCode === null && child.signalCode === null) child.kill();
        }
        return result;
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

/** Bound the actual read, including files that grow after stat. */
async function readSearchFile(
    path: string,
    buffer: Buffer,
): Promise<{ text?: string; oversized: boolean }> {
    const file = await open(path, "r").catch(() => undefined);
    if (!file) return { oversized: false };
    try {
        const info = await file.stat();
        if (!info.isFile()) return { oversized: false };
        if (info.size > MAX_FILE_BYTES) return { oversized: true };
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
            if (bytesRead === 0) break;
            size += bytesRead;
        }
        if (size > MAX_FILE_BYTES) return { oversized: true };
        const bytes = buffer.subarray(0, size);
        if (bytes.includes(0)) return { oversized: false };
        return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), oversized: false };
    } catch {
        return { oversized: false };
    } finally {
        await file.close();
    }
}

async function runFallback(
    env: ExecutionToolContext["env"],
    root: string,
    params: GrepToolInput,
    piContext: Context,
): Promise<SearchResult> {
    const ig = await loadIgnoreFilter(env, root, piContext);
    const re = new RegExp(params.pattern, params.ignoreCase ? "i" : "");

    const files = fg.stream(searchPattern(params), {
        cwd: root,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        suppressErrors: true,
        ignore: SAFE_DEFAULT_IGNORES,
    });
    const result = searchResult();
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    for await (const entry of files) {
        if (piContext.abortSignal?.aborted) throw new Error("Operation aborted");
        // The walker yields `src\a.ts` on Windows; normalise so .gitignore
        // matching and `file:line` output keep the tool's forward-slash
        // contract. POSIX paths never contain `\`, so gate the rewrite.
        const rel =
            process.platform === "win32" ? String(entry).replace(/\\/g, "/") : String(entry);
        if (ig?.(rel)) continue;
        const absPath = resolve(root, rel);
        const { text, oversized } = await readSearchFile(absPath, buffer);
        if (oversized) result.skippedLarge++;
        if (text === undefined) continue;
        if (piContext.abortSignal?.aborted) throw new Error("Operation aborted");
        // Split on CRLF too. Not platform-gated: a CRLF file reaches a POSIX
        // checkout as well (an autocrlf checkout, a file copied from Windows),
        // and the trailing `\r` would ride along in every match row and break
        // `$` anchors.
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) appendMatch(result, `${rel}:${i + 1}:${lines[i]}`);
        }
    }
    return result;
}

export function createGrepTool(): GrepTool {
    return {
        name: "grep",
        label: "grep",
        description:
            "Search file contents by regex or literal string. Respects .gitignore and excludes safe defaults (node_modules/.git/dist/build/.next) and binary files. Without ripgrep, files over 2 MiB are skipped with a notice. Returns matching 'file:line: text' rows, up to 300 lines / 50k chars; long lines are clipped.",
        parameters: grepSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Regex / literal search across files — the tool for finding *where* a symbol or string appears; use `glob` to find files by name instead. Honours .gitignore and skips node_modules/.git/dist/build/.next and binary files. Without ripgrep, files over 2 MiB are skipped with a notice. Returns up to 300 `file:line: text` rows (50k chars total, long lines clipped) — if you hit the cap, narrow the pattern or `glob`. Safe to issue in parallel in the same turn.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: GrepToolInput,
            _onUpdate: unknown,
            { env }: ExecutionToolContext,
            _invocation: unknown,
            piContext: Context,
        ): Promise<{ content: TextContent[]; details: { count: number; truncated: boolean } }> {
            // pi 0.85 carries cancellation on the Context rather than a
            // dedicated parameter.
            const signal = piContext.abortSignal;
            const cwdResult = await env.absolutePath(params.path ?? ".", piContext);
            const root = getOrThrow(cwdResult);
            const ignoreContent = await buildRipgrepIgnoreContent(env, root, piContext);

            const result = hasRipgrep()
                ? await runRipgrep(root, params, ignoreContent, piContext)
                : await runFallback(env, root, params, piContext);

            if (signal?.aborted) throw new Error("Operation aborted");
            const shown = result.lines;
            const omitted = result.count - shown.length;
            const truncated = omitted > 0 || result.clipped || result.skippedLarge > 0;
            const body =
                shown.length === 0
                    ? "(no matches)"
                    : shown.join("\n") + (omitted > 0 ? `\n… (${omitted} more)` : "");
            const skipped =
                result.skippedLarge > 0
                    ? `\nSkipped ${result.skippedLarge} file(s) larger than 2 MiB; search is incomplete.`
                    : "";
            return {
                content: [{ type: "text", text: body + skipped }],
                details: { count: result.count, truncated },
            };
        },
    };
}
