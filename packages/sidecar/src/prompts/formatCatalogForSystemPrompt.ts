/**
 * Catalog blocks that used to live inside tool JSON (`addTools.description`,
 * `agent.description` / parameter schema). Those fields sit on the tools
 * cache breakpoint, so a newly loaded deferred tool or a newly registered
 * agent type rewrote the whole tools array and missed the prefix.
 *
 * The listings now append to the system prompt (dynamic tail). Tool JSON
 * stays process-stable; only the catalog section changes, which is the
 * cheaper miss.
 */

export interface DeferredToolCatalogEntry {
    readonly name: string;
    readonly summary: string;
}

export interface AgentTypeCatalogEntry {
    readonly agentType: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly context?: "independent" | "fork";
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** `<deferred_tools>` listing for the system-prompt dynamic tail. Empty → `""`. */
export function formatDeferredToolsForSystemPrompt(
    entries: ReadonlyArray<DeferredToolCatalogEntry>,
): string {
    if (entries.length === 0) return "";
    const lines = [
        "Deferred tools are not loaded until you call `addTools` with their names.",
        "Already-loaded names are no-ops. Unknown names are reported in the tool result.",
        "",
        "<deferred_tools>",
    ];
    for (const entry of entries) {
        lines.push("  <tool>");
        lines.push(`    <name>${escapeXml(entry.name)}</name>`);
        lines.push(`    <summary>${escapeXml(entry.summary)}</summary>`);
        lines.push("  </tool>");
    }
    lines.push("</deferred_tools>");
    return lines.join("\n");
}

/** `<available_agents>` listing for the system-prompt dynamic tail. Empty → `""`. */
export function formatAgentsForSystemPrompt(types: ReadonlyArray<AgentTypeCatalogEntry>): string {
    if (types.length === 0) return "";
    const lines = [
        "Delegate with the `agent` tool. Pick `subagent_type` by capability, not by tool overlap.",
        "",
        "<available_agents>",
    ];
    for (const t of types) {
        const summary = oneLine(t.whenToUse ?? t.description ?? "");
        const forkNote =
            t.context === "fork"
                ? " Defaults to forked context (sees this conversation; costs more than an independent spawn)."
                : "";
        lines.push("  <agent>");
        lines.push(`    <name>${escapeXml(t.agentType)}</name>`);
        if (summary.length > 0) {
            lines.push(
                `    <when_to_use>${escapeXml(summary)}${escapeXml(forkNote)}</when_to_use>`,
            );
        } else if (forkNote) {
            lines.push(`    <when_to_use>${escapeXml(forkNote.trim())}</when_to_use>`);
        }
        lines.push("  </agent>");
    }
    lines.push("</available_agents>");
    return lines.join("\n");
}
