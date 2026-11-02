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
import { fileAccessOf } from "../tools/fileAccess.ts";

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
 * When a profile declares `tools:`, that list bounds both the initial toolset
 * (`filterToolsForAgent`) and the deferred-load path. The deferred path used
 * to ignore it, which let a read-only profile load `configPatch` (mutates the
 * user's global config — no path argument, so the mutation gate does not see
 * it), `pdfMerge` / `pdfSplit` / `pdfFill` (write files) or `sessionSearch` /
 * `sessionList` (read the user's private transcripts), none of which its body
 * says it may do.
 *
 * A profile with no `tools:` list inherits the parent's full load surface;
 * that is the existing meaning of "inherit all", and the depth guard still
 * applies.
 *
 * The whitelist is the same list the initial toolset was filtered by, so a
 * tool the profile declared stays loadable even when it is deferred — the
 * filter does not accidentally strip a capability the profile asked for.
 */
export interface AgentToolPolicy {
    /** Names the session may load; undefined = inherit the full load surface. */
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
 * Agent types whose `shell` tool is swapped for a read-only-broker instance.
 *
 * Membership is a permission boundary, not a hint: these profiles tell the
 * model it must not mutate anything, and prose alone does not stop a shell
 * call. Any profile whose body claims read-only must be listed here, or the
 * child inherits the user's root-session allowlist and can write.
 *
 * Lives here, not in the subagent runner, because it is an agent-definition
 * fact: both the shell swap (`childAttach`) and the caller-visible
 * `read_only` label (`workspace`) decide from it.
 */
export const READ_ONLY_SHELL_AGENT_TYPES: ReadonlySet<string> = new Set(["explorer", "reviewer"]);

/**
 * Whether an agent can create or modify a file.
 *
 * "writes" covers every route, not just the `write` tool: a writable shell can
 * write a file, and the PDF tools (`pdfMerge` / `pdfSplit` / `pdfFill`) write
 * their output. Only a profile with no writer at all is `"read-only"` — a
 * profile with a working shell is not, even if it lacks `write` / `edit`
 * (`verification` runs builds and writes throwaway scripts).
 *
 * `toolNames === undefined` means "inherits the parent's tools", which may or
 * may not include a writer; it is treated as "writes" so a caller never
 * labels an inheriting agent read-only and withholds an output path it could
 * actually honour.
 *
 * Callers must exclude `claude-code` profiles: their names are Claude Code's
 * own, where `Bash` writes a file regardless of what the list says.
 */
export function writeCapability(
    toolNames: readonly string[] | undefined,
    agentType: string | undefined,
): "writes" | "read-only" {
    if (!toolNames) return "writes";
    const names = new Set(toolNames.map((n) => n.toLowerCase()));
    if (
        names.has("shell") &&
        (agentType === undefined || !READ_ONLY_SHELL_AGENT_TYPES.has(agentType))
    ) {
        return "writes";
    }
    // `fileAccessOf` is keyed by the registry's exact tool name (`pdfMerge`,
    // not `pdfmerge`), so consult the original spelling.
    for (const name of toolNames) {
        if (fileAccessOf(name)?.write !== undefined) return "writes";
    }
    return "read-only";
}

/** Whether the toolset contains the direct file-editing tools. */
export function hasDirectWriteTool(toolNames: readonly string[]): boolean {
    return toolNames.some((n) => {
        const name = n.toLowerCase();
        return name === "write" || name === "edit";
    });
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
