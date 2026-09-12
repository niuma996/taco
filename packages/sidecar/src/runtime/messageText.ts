/**
 * Extract display text from a harness AgentMessage — used to hand drained
 * steering messages back to clients (session.abort's discardedSteer /
 * discardedFollowUp) so an interrupted steer can be restored into the
 * composer instead of being lost.
 */

import type { AgentMessage } from "./pi/types.ts";

/** Concatenate the text parts of a message; "" for non-text content. */
export function textFromAgentMessage(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
}

/**
 * Map a drained queue batch to its texts, in drain order, dropping entries with
 * no text at all. An image-only steer yields "", which clients would otherwise
 * restore into the composer as a stray blank line.
 */
export function textsFromAgentMessages(messages: AgentMessage[]): string[] {
    return messages.map(textFromAgentMessage).filter((text) => text !== "");
}
