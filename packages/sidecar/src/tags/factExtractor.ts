/**
 * Transcript serializer used by the memory extractor. Compaction no longer
 * calls this file — pin-aware compact is one LLM call through pi.
 */

import type { AgentMessage } from "../runtime/pi/types.ts";

/**
 * Format messages into plain text for an extraction prompt. Deliberately not
 * pi's `serializeConversation`: that one truncates tool results to 2000 chars,
 * which is exactly where supporting evidence tends to live, and it requires
 * pre-converting to LLM messages. This accepts `AgentMessage[]` and degrades
 * gracefully.
 */
export function serializeMessagesForFacts(messages: ReadonlyArray<AgentMessage>): string {
    const lines: string[] = [];
    for (const m of messages) {
        const role = (m as { role?: unknown }).role;
        const content = (m as { content?: unknown }).content;
        let body: string;
        if (typeof content === "string") {
            body = content;
        } else if (Array.isArray(content)) {
            body = content
                .map((b) => {
                    if (!b || typeof b !== "object") return "";
                    const bb = b as Record<string, unknown>;
                    if (bb.type === "text" && typeof bb.text === "string") return bb.text;
                    if (bb.type === "toolCall") return `[tool_call: ${String(bb.name)}]`;
                    return "";
                })
                .filter(Boolean)
                .join("\n");
        } else {
            body = "";
        }
        lines.push(`[${typeof role === "string" ? role : "unknown"}]\n${body}\n`);
    }
    return lines.join("\n");
}
