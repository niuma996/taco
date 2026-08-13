/**
 * `toolSummaryForPrompt` — render the per-tool routing guide from inline
 * `taco` metadata that each tool's factory declares on itself.
 *
 * Why per-tool metadata, not a central table:
 *
 *  - Single source of truth — adding a new tool means changing one file
 *    (`createXxxTool`) rather than two (the factory + a central map). The
 *    central-table version was easy to drift: a new tool would render with
 *    a fallback line until someone noticed it was missing.
 *  - Co-location — the prose lives next to the schema description that
 *    actually defines what the tool does, so updates tend to land together.
 *
 * Schema description (the JSON-schema `description:` field) and the
 * `promptSummary` field are intentionally *not* duplicates: the schema
 * description goes into the tool spec the model sees in every turn, while
 * `promptSummary` is the one-line "when to prefer this tool vs. its
 * siblings" prose that ships in the system prompt. They have different
 * budgets (spec prose must fit inside the tool's schema; system-prompt
 * prose shares budget with everything else).
 *
 * Unknown tools (no `promptSummary`) still render a fallback line so they
 * never disappear from the prompt silently — this is the failure-safe
 * behaviour we want: if a tool's author forgets metadata, the model still
 * knows the tool exists.
 */

import type { NamedTool } from "./types.ts";

interface ResolvedEntry {
    readonly name: string;
    /** Defaults to true (conservative — treat unknowns as mutating). */
    readonly mutates: boolean;
    readonly summary: string;
}

const FALLBACK_SUMMARY = "See the tool's schema `description` for usage.";

/** Resolve a single tool's routing-guide entry, applying defaults. */
function resolve(tool: NamedTool): ResolvedEntry {
    const meta = tool.taco;
    const summary = meta?.promptSummary?.trim();
    return {
        name: tool.name,
        mutates: meta?.mutates ?? true,
        summary: summary && summary.length > 0 ? summary : FALLBACK_SUMMARY,
    };
}

/**
 * Build the `<tool_summary>` block for the system prompt. Renders one line
 * per available tool, in the order they appear in `tools` (callers
 * control ordering — `defaultToolsWithTasks` returns them in the order
 * they should appear in the prompt).
 */
export function toolSummaryForPrompt(tools: ReadonlyArray<NamedTool>): string {
    if (tools.length === 0) return "";

    const lines: string[] = [
        "Tool routing guide (one line per tool — see each tool's schema `description` for parameters):",
        "",
    ];
    for (const tool of tools) {
        const entry = resolve(tool);
        const tag = entry.mutates ? "[mutates]" : "[read-only]";
        lines.push(`- ${entry.name} ${tag} — ${entry.summary}`);
    }
    lines.push("");
    lines.push(
        "Tools marked [read-only] can be issued in parallel within the same turn. " +
            "Tools marked [mutates] should generally be issued one at a time so failures are recoverable.",
    );
    return lines.join("\n");
}
