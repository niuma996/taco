/**
 * Subagent tool filtering:
 *   1. Intersect available tools with the whitelist (unrecognised names are dropped).
 *   2. When depth>=1, always remove the main-session-only tools, regardless of
 *      whitelist: `agent` (recursion guard) and the user-interaction tools.
 *
 * whitelist === undefined means "inherit all available" (depth guard still applies).
 *
 * Frontmatter tool names match strictly — no aliasing between `bash` / `powershell`
 * and `shell`; write new agent frontmatter with `shell`.
 */

import type { AgentHarnessTool, ExecutionToolContext } from "../runtime/pi/types.ts";

type AgentTool = AgentHarnessTool<ExecutionToolContext>;

export const AGENT_TOOL_NAME = "agent";

/**
 * Tools a subagent (depth>=1) never receives.
 *
 * - `agent` — recursion guard: subagents may not spawn further subagents.
 * - `askUser` / `planEnter` / `planExit` — these end the run (`terminate: true`)
 *   to wait for the user's answer, but a subagent has no user channel: the
 *   desktop submits answers to the parent session only. A child that calls
 *   one stops with its question unanswerable, and the parent gets back an
 *   empty-response error or a truncated result. Plan mode is a main-session
 *   UI concept on top of that.
 *
 * A subagent that needs a user decision reports it in its final reply and
 * the parent asks.
 */
export const MAIN_SESSION_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    AGENT_TOOL_NAME,
    "askUser",
    "planEnter",
    "planExit",
]);

export function filterToolsForAgent(
    available: AgentTool[],
    whitelist: string[] | undefined,
    depth: number,
): AgentTool[] {
    let result: AgentTool[];
    if (whitelist === undefined) {
        result = [...available];
    } else {
        const wanted = new Set(whitelist);
        result = available.filter((t) => wanted.has(t.name));
    }
    if (depth >= 1) {
        result = result.filter((t) => !MAIN_SESSION_ONLY_TOOL_NAMES.has(t.name));
    }
    return result;
}

/**
 * What a session may load on demand.
 *
 * A profile's `tools:` list is its complete declaration, but only the
 * *initial* toolset was filtered against it (`filterToolsForAgent`). The
 * deferred-load path was not: every session gets an `addTools` tool, so a
 * read-only profile could load `configPatch` (mutates the user's global
 * config — no path argument, so the mutation gate does not see it),
 * `pdfMerge` / `pdfSplit` / `pdfFill` (write files) or `sessionSearch` /
 * `sessionList` (read the user's private transcripts), none of which its body
 * says it may do.
 *
 * The whitelist is the same list the initial toolset was filtered by, so a
 * tool the profile declared stays loadable even when it is deferred — the
 * filter does not accidentally strip a capability the profile asked for.
 */
export interface AgentToolPolicy {
    /** Names the session may load; undefined = any candidate. */
    readonly allowed?: ReadonlySet<string>;
    /** Names refused regardless of `allowed`. */
    readonly denied: ReadonlySet<string>;
}

/**
 * Build the on-demand load policy for a session spawned at `depth`.
 *
 * `whitelist` is the profile's declared tool list, or undefined when it
 * inherits the parent's tools. The depth guard rides along so a subagent
 * cannot pick up a main-session-only tool it was stripped at spawn time.
 */
export function agentToolPolicy(
    whitelist: readonly string[] | undefined,
    depth: number,
): AgentToolPolicy {
    return {
        allowed: whitelist ? new Set(whitelist) : undefined,
        denied: depth >= 1 ? MAIN_SESSION_ONLY_TOOL_NAMES : new Set<string>(),
    };
}

/**
 * Whether a profile's own toolset can create or modify a file.
 *
 * A profile that declares an explicit whitelist without `write` / `edit`
 * cannot; one that declares no whitelist inherits the parent's tools and may
 * or may not have them, so the answer is "possibly".
 *
 * Callers that need a definite yes/no must also exclude `claude-code`
 * profiles: their whitelist names Claude Code's own tools, where `Bash` can
 * write a file no matter what the list says.
 */
export function agentCanWriteFiles(whitelist: readonly string[] | undefined): boolean {
    if (!whitelist) return true;
    const names = new Set(whitelist.map((n) => n.toLowerCase()));
    return names.has("write") || names.has("edit");
}

/**
 * OR-aggregated "subagent visibility" check: given a list of agent whitelists,
 * is there at least one agent for which a depth=1 subagent could see this tool?
 *   - main-session-only tool → always false (depth guard)
 *   - no agent has a whitelist → all tools inherit, visible (true)
 *   - some agent's whitelist contains this tool (or that agent has no whitelist) → true
 *   - every explicit whitelist excludes this tool → false
 * OR aggregation better matches "can any of my subagents use it?" — avoids false negatives
 * where one agent omitting a tool would incorrectly flag the whole set as unavailable.
 */
export function isToolVisibleForAnySubagent(
    name: string,
    whitelists: Array<string[] | undefined>,
): boolean {
    if (MAIN_SESSION_ONLY_TOOL_NAMES.has(name)) return false;
    let sawExplicitWhitelist = false;
    for (const wl of whitelists) {
        if (wl === undefined) {
            // Inherit all → this agent definitely exposes the tool
            return true;
        }
        sawExplicitWhitelist = true;
        if (wl.includes(name)) return true;
    }
    // Every agent has an explicit whitelist and none includes this tool → invisible
    return !sawExplicitWhitelist;
}
