/**
 * Subagent tool filtering:
 *   1. Intersect available tools with the whitelist (unrecognised names are dropped).
 *   2. When depth>=1, always remove "agent" (recursion guard), regardless of whitelist.
 *
 * whitelist === undefined means "inherit all available" (depth guard still applies).
 *
 * Frontmatter tool names match strictly — no aliasing between `bash` / `powershell`
 * and `shell`; write new agent frontmatter with `shell`.
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";

type AgentTool = AgentHarnessTool<ExecutionToolContext>;

export const AGENT_TOOL_NAME = "agent";

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
    // Recursion guard: subagents (depth>=1) may not spawn further subagents
    if (depth >= 1) {
        result = result.filter((t) => t.name !== AGENT_TOOL_NAME);
    }
    return result;
}

/**
 * OR-aggregated "subagent visibility" check: given a list of agent whitelists,
 * is there at least one agent for which a depth=1 subagent could see this tool?
 *   - name === AGENT_TOOL_NAME → always false (depth guard)
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
    if (name === AGENT_TOOL_NAME) return false;
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
