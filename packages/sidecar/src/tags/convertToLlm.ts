/**
 * Tag system integration helpers for AgentHarness. Hooks into two points:
 *   1. `context` hook — strips `drop` policy tags before LLM sees them.
 *   2. TUI layer — strips `hidden` tags; unwraps `ephemeral` so inner content shows.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { stripDropTagsFromMessages } from "./policy/dropPolicy.ts";
import { stripThinkingFromAssistantMessages } from "./policy/stripThinking.ts";
import { stripEphemeralTagWrappers, stripHiddenTagsInMarkdown } from "./policy/visibility.ts";

export { buildInstructionsContextHook } from "./instructionsContext.ts";

/**
 * Build a `context` hook that strips `drop` policy tags from messages before
 * they reach the LLM. Non-text-body messages (without a `content` field) pass
 * through unchanged via `stripDropTagsFromMessages`.
 *
 * Usage: `harness.on("context", buildDropPolicyContextHook());`
 */
export function buildDropPolicyContextHook() {
    return (event: { messages: AgentMessage[] }): { messages: AgentMessage[] } => {
        const processed = stripDropTagsFromMessages(event.messages);
        // Mutate in-place: multiple context hooks share the same event.messages
        // reference, so in-place mutation is the only way they compose under
        // pi-agent-core's last-writer-wins emitHook semantics.
        event.messages.length = 0;
        event.messages.push(...processed);
        return { messages: event.messages };
    };
}

/**
 * Build a `context` hook that strips `ThinkingContent` blocks from assistant
 * messages when the current `thinkingLevel` is `"off"`. Returning `undefined`
 * makes `emitHook` keep the prior handler's result, so when thinking is
 * enabled this hook is a true no-op.
 *
 * Usage:
 * `harness.on("context", buildStripThinkingContextHook(() => this.harness.getThinkingLevel()));`
 */
export function buildStripThinkingContextHook(
    getThinkingLevel: () => ThinkingLevel,
): (event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined {
    return (event) => {
        if (getThinkingLevel() !== "off") return undefined;
        const processed = stripThinkingFromAssistantMessages(event.messages);
        event.messages.length = 0;
        event.messages.push(...processed);
        return { messages: event.messages };
    };
}

/**
 * Apply TUI visibility policies to a string (hidden tag stripping + ephemeral wrapper removal).
 * Use this for the text shown to the user in the TUI.
 */
export function applyTuiVisibility(text: string): string {
    return stripEphemeralTagWrappers(stripHiddenTagsInMarkdown(text));
}

/**
 * Apply TUI visibility policies to a message's content.
 * Works for both string and block[] content.
 */
export function applyTuiVisibilityToContent(
    content: string | (TextContent | ImageContent)[],
): string | (TextContent | ImageContent)[] {
    if (typeof content === "string") {
        return applyTuiVisibility(content);
    }
    return content.map((block) => {
        if (block.type === "text") {
            const cleaned = applyTuiVisibility(block.text);
            return cleaned === block.text ? block : { ...block, text: cleaned };
        }
        return block;
    });
}
