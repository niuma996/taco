/**
 * `toolSummaryForPrompt` — render the per-tool routing guide from inline
 * `taco` metadata that each tool's factory declares on itself, co-located
 * with the schema description that defines what the tool does.
 *
 * Schema description and `promptSummary` are intentionally not duplicates: the
 * description goes into the tool spec the model sees in every turn, while
 * `promptSummary` is the one-line "when to prefer this tool" prose that ships
 * in the system prompt — they have different budgets.
 *
 * Unknown tools (no `promptSummary`) still render a fallback line so they
 * never disappear from the prompt silently.
 */

import type { NamedTool } from "./types.ts";

interface ResolvedEntry {
    readonly name: string;
    /** Defaults to true (conservative — treat unknowns as mutating). */
    readonly mutates: boolean;
    /** Defaults to false. */
    readonly destructive: boolean;
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
        destructive: meta?.destructive ?? false,
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
        const tags = [entry.mutates ? "mutates" : "read-only"];
        if (entry.destructive) tags.push("destructive");
        const tag = `[${tags.join(", ")}]`;
        lines.push(`- ${entry.name} ${tag} — ${entry.summary}`);
    }
    lines.push("");
    lines.push("Concurrency:");
    // `askUser` is read-only in the "does not mutate files" sense but blocks
    // the turn waiting for a human answer — the opposite of batchable.
    const askUserException = tools.some((tool) => tool.name === "askUser")
        ? " `askUser` is the exception: it waits for the user's reply, so call it on its own."
        : "";
    lines.push(
        `- Tools marked [read-only] are concurrency-safe — batch them freely in one turn.${askUserException}`,
    );
    lines.push(
        "- Mutating calls to the SAME file are serialized, but their order is not guaranteed — " +
            "do not make one edit depend on another's effect within the same turn; put the dependent call in the next turn.",
    );
    lines.push("- Mutating calls to DIFFERENT files are independent — batch them.");
    if (tools.some((tool) => tool.name === "shell")) {
        lines.push(
            "- When one step's output feeds the next, keep the work sequential. Combine shell commands only when the current shell supports the syntax; otherwise use separate calls.",
        );
    } else {
        lines.push(
            "- When one step's output feeds the next, make the dependent calls sequentially rather than batching them.",
        );
    }
    return lines.join("\n");
}
