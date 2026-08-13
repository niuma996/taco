/**
 * toolAssembly — pure functions for tool set assembly.
 * Extracted from WorkspaceRuntime to make "merge builtin + extension tools with dedup" logic
 * testable in isolation without an EventEmitter context.
 */

import type { ImWorkspacePolicy } from "../channels/imWorkspacePolicy.ts";
import { IM_FS_TOOL_NAMES, IM_SHELL_TOOL_NAME } from "../channels/virtualWorkspace.ts";
import { createLogger } from "../lib/logger.ts";
import type { TacoTool } from "../tools/index.ts";

const log = createLogger("taco-ext");

/**
 * Append extension tools after builtin tools, with same-named extension tools overriding builtin ones.
 * AgentHarness constructor validates tool name uniqueness — spreading directly triggers a Duplicate error.
 *
 * Handles two kinds of same-name conflict (§4.3 design):
 *   - extension overrides builtin tool → logs one warn: `extension "X" overrode built-in tool "Y"`
 *   - extension vs extension same name (last-registered wins) → already warned at extensionApi.registerTool;
 *     here we only dedupe to the last version, no additional warn
 */
export function dedupOverride(
    base: TacoTool[],
    overrides: Array<{ name: string; tool: TacoTool }>,
): TacoTool[] {
    // Dedupe within overrides by name (last-registered wins; registration order = push order)
    const lastByName = new Map<string, { name: string; tool: TacoTool }>();
    for (const o of overrides) lastByName.set(o.tool.name, o);
    const overrideNames = new Set(lastByName.keys());
    // Extension overrides builtin: warn explicitly
    for (const t of base) {
        if (overrideNames.has(t.name)) {
            const winner = lastByName.get(t.name);
            log.warn(`extension "${winner?.name}" overrode built-in tool "${t.name}"`);
        }
    }
    return [
        ...base.filter((t) => !overrideNames.has(t.name)),
        ...[...lastByName.values()].map((e) => e.tool),
    ];
}

/**
 * Apply an IM workspace policy to a fully assembled tool set.
 *
 * Runs LAST, after extension/custom tools have been merged, so a same-named
 * `shell` / `read` / `write` / `edit` / `grep` / `glob` contributed by an
 * extension cannot reintroduce a tool the policy denies. Non-fs tools
 * (agent, skill, todo_write, memory, ask_user) are never removed.
 */
export function filterToolsForImPolicy(tools: TacoTool[], policy: ImWorkspacePolicy): TacoTool[] {
    const drop = new Set<string>();
    if (policy.tools.fsTools === "deny") {
        for (const name of IM_FS_TOOL_NAMES) drop.add(name);
    }
    if (policy.tools.shell === "deny") {
        drop.add(IM_SHELL_TOOL_NAME);
    }
    return drop.size === 0 ? tools : tools.filter((t) => !drop.has(t.name));
}
