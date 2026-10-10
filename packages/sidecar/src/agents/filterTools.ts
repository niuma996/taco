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
