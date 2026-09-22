/**
 * Deterministic tool order for the harness array and the system-prompt
 * `TOOL_NAMES` / `<tool_summary>` listing.
 *
 * Two consumers used to disagree: `defaultToolsWithTasks` returned insertion
 * order, while `createToolsetRefresher` merged as `[...next.tools, ...kept]`.
 * A same-name reshuffle then looked like a toolset change (`refreshToolset`
 * compares the `\u0000`-joined name string) and paid a full prompt-cache miss.
 *
 * Order is `localeCompare` on `name` — no builtin rank table. Plugins, MCP
 * tools, and deferred candidates sort in the same space as builtins, so a
 * newly registered name cannot land in an unranked tail and reshuffle the
 * prefix. Prompt-cache only needs: same set → same sequence.
 */

/** Sort by `name` with `localeCompare`. Equal names keep relative order. */
export function orderTools<T extends { name: string }>(tools: readonly T[]): T[] {
    return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

/** `\u0000`-joined names after `orderTools` — the comparison key `refreshToolset` uses. */
export function toolNamesKey(tools: readonly { name: string }[]): string {
    return orderTools(tools)
        .map((t) => t.name)
        .join("\u0000");
}
