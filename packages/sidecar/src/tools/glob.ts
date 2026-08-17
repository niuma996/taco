/**
 * glob tool — list paths matching a glob pattern (relative to cwd).
 * Uses fast-glob; safe defaults shield node_modules/dist/build, then the
 * `ignore` package reads .gitignore for further filtering. Results are
 * truncated to MAX_RESULTS to avoid flooding context.
 */

import { isAbsolute, relative } from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { getOrThrow } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import fg from "fast-glob";
import ignore from "ignore";
import type { Static } from "typebox";
import { Type } from "typebox";
import { BASE_SAFE_DEFAULT_IGNORES } from "./safeDefaults.ts";

export type GlobTool = AgentHarnessTool<ExecutionToolContext>;

const MAX_RESULTS = 500;

// fast-glob 3.x does not read .gitignore. These are "git-independent" safe
// defaults passed via fast-glob's ignore option (minimatch patterns).
const SAFE_DEFAULT_IGNORES = BASE_SAFE_DEFAULT_IGNORES;

const globSchema = Type.Object({
    pattern: Type.String({ description: "Glob pattern, e.g. 'src/**/*.ts'." }),
    path: Type.Optional(
        Type.String({
            description: "Root dir to search (relative to cwd or absolute). Defaults to cwd.",
        }),
    ),
});

export type GlobToolInput = Static<typeof globSchema>;

export function createGlobTool(): GlobTool {
    return {
        name: "glob",
        label: "glob",
        description:
            "List files matching a glob pattern. Respects .gitignore and excludes safe defaults (node_modules/.git/dist/build/.next). Returns up to 500 relative paths.",
        parameters: globSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "List files matching a glob (e.g. `src/**/*.ts`) — the tool for finding files by name or pattern; use `grep` to search *inside* files instead. Honours .gitignore. Returns up to 500 relative paths. Safe to parallelise with `grep` in the same turn.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: GlobToolInput,
            signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            { env }: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: { count: number; truncated: boolean } }> {
            const cwdResult = await env.absolutePath(params.path ?? ".", signal);
            const root = getOrThrow(cwdResult);

            let matches = await fg(params.pattern, {
                cwd: root,
                dot: false,
                ignore: SAFE_DEFAULT_IGNORES,
                onlyFiles: true,
                followSymbolicLinks: false,
                suppressErrors: true,
            });

            // fast-glob does not parse .gitignore — fill the gap with the `ignore` package.
            const gitignoreResult = await env.readTextFile(`${root}/.gitignore`, signal);
            if (gitignoreResult.ok) {
                const ig = ignore().add(gitignoreResult.value);
                matches = matches.filter((m) => {
                    const rel = isAbsolute(m) ? relative(root, m) : m;
                    try {
                        return !ig.ignores(rel);
                    } catch {
                        // `ignore` rejects non-relative paths; default to keeping
                        // the match rather than failing the whole tool call.
                        return true;
                    }
                });
            }

            if (signal?.aborted) throw new Error("Operation aborted");
            const truncated = matches.length > MAX_RESULTS;
            const shown = truncated ? matches.slice(0, MAX_RESULTS) : matches;
            const body =
                shown.length === 0
                    ? "(no matches)"
                    : shown.join("\n") +
                      (truncated ? `\n… (${matches.length - MAX_RESULTS} more)` : "");
            return {
                content: [{ type: "text", text: body }],
                details: { count: matches.length, truncated },
            };
        },
    };
}
