/**
 * Tag builder utilities — defineTag, tagWrap, escapeAttr, createUserMessage.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { TagSpec } from "./types.ts";

/** Construct a deeply-frozen TagSpec. */
export function defineTag(spec: TagSpec): TagSpec {
    return Object.freeze({ ...spec });
}

/** Build a single-part user message wrapping `text`. Used by tag hooks to inject system-style content. */
export function createUserMessage(text: string): AgentMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
}

/** XML attribute value escaping. */
export function escapeAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/**
 * Wrap `content` in an XML tag pair.
 * @example tagWrap("request", "How do I reverse a linked list?")
 * // => `<request>\nHow do I reverse a linked list?\n</request>`
 */
export function tagWrap<N extends string>(
    name: N,
    content: string,
    attrs?: Readonly<Record<string, string>>,
): string {
    const attrStr =
        attrs && Object.keys(attrs).length > 0
            ? ` ${Object.entries(attrs)
                  .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
                  .join(" ")}`
            : "";
    return `<${name}${attrStr}>\n${content}\n</${name}>`;
}
