/**
 * Turns the sidecar push stream into channel-bound text.
 *
 * A channel receives every frame for its im:// workspaces, but a channel peer
 * should only see the agent's final answer — thinking blocks, tool calls and
 * tool results are noise in a chat window. Pure functions so this is testable
 * without the SDK or a live socket.
 */

import type { ServerPush } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";

interface MessageEndEvent {
    type?: string;
    message?: { role?: string; content?: unknown };
}

/**
 * Extracts the assistant's visible text from one push frame, or undefined when
 * the frame carries nothing a peer should see.
 */
export function extractReplyText(frame: ServerPush): string | undefined {
    // A workspace-dimensioned notice (e.g. im.tools_enabled) carries its own
    // text and is addressed to the chat directly — not to a conversation turn.
    if (frame.method === PushMethods.ImToolsEnabled) {
        const text = (frame.params as { text?: unknown } | undefined)?.text;
        if (typeof text === "string" && text.trim().length > 0) return text.trim();
        return undefined;
    }
    if (frame.method !== PushMethods.Event) return undefined;
    const event = (frame.params as { event?: MessageEndEvent } | undefined)?.event;
    if (event?.type !== "message_end" || event.message?.role !== "assistant") return undefined;

    const content = event.message.content;
    // pi-ai 0.83+ always emits AssistantMessage.content as ProtocolContentBlock[];
    // a string content is never produced by the current contract, so a non-array
    // here is just an unknown shape we cannot render.
    if (!Array.isArray(content)) return undefined;

    // Only `text` blocks: thinking is internal, toolCall/toolResult are noise.
    const text = content
        .filter(
            (b): b is { type: "text"; text: string } =>
                typeof b === "object" &&
                b !== null &&
                (b as { type?: unknown }).type === "text" &&
                typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("")
        .trim();
    return text.length > 0 ? text : undefined;
}

/**
 * Notice broadcast to peers when a policy change interrupts their in-progress
 * turn. No per-locale concept exists on the peer side, so the text is static;
 * keep it short and actionable.
 */
const INTERRUPT_NOTICE_TEXT =
    "A policy change interrupted this conversation's active turn. It can be resumed or restarted.";

/** The text sent to a peer whose conversation turn was cut short by a policy change. */
export function interruptNoticeText(): string {
    return INTERRUPT_NOTICE_TEXT;
}

/**
 * Splits text to fit the platform's per-message cap, preferring paragraph then
 * line then whitespace boundaries so a reply is not cut mid-word. A single
 * token longer than the limit is hard-split rather than dropped.
 */
export function chunkText(text: string, maxLength: number): string[] {
    if (maxLength <= 0) return [text];
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let rest = text;
    while (rest.length > maxLength) {
        const window = rest.slice(0, maxLength);
        let cut = -1;
        for (const sep of ["\n\n", "\n", " "]) {
            cut = window.lastIndexOf(sep);
            if (cut > 0) {
                cut += sep.length;
                break;
            }
        }
        if (cut <= 0) cut = maxLength;
        const piece = rest.slice(0, cut).trim();
        if (piece.length > 0) chunks.push(piece);
        rest = rest.slice(cut);
    }
    const tail = rest.trim();
    if (tail.length > 0) chunks.push(tail);
    return chunks;
}
