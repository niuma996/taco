/**
 * `associated_workspaces` tag — context hook.
 *
 * Tells the model which directories the workspace is associated with, so it
 * can `cd` into them and read files there. The paths are injected per turn
 * rather than baked into the system prompt: the set is user configuration
 * that can change while a session is live, and the system prompt is the
 * model's KV-cache prefix — rewriting it would cost a cache miss on every
 * change.
 *
 * The tag is `drop` at compaction, so the next call after a compact
 * re-injects it. Unchanged content already in the window is not re-appended
 * — the same guard `<instructions>` uses, for the same reason: a re-append
 * rewrites the tail of the context and loses the cache.
 *
 * An empty set injects nothing: a workspace with no associations has
 * nothing to say about it, and a tag naming zero directories is noise.
 */

import type { ContextEvent, ContextResult } from "../extensions/types.ts";
import type { AgentMessage } from "../runtime/pi/types.ts";
import { appendUserTag } from "./appendUserTag.ts";
import { findBalancedTagsSkippingFences } from "./fenceAware.ts";

export interface BuildAssociatedWorkspacesContextHookOptions {
    /**
     * The workspace's associated directories, resolved on every call so a
     * grant added or removed mid-session reaches the next turn.
     */
    getRoots: () => readonly string[];
}

export function buildAssociatedWorkspacesContextHook(
    opts: BuildAssociatedWorkspacesContextHookOptions,
): (event: ContextEvent) => ContextResult | undefined {
    return (event: ContextEvent): ContextResult | undefined => {
        const roots = opts.getRoots();
        if (roots.length === 0) return undefined;
        if (hasSameRoots(event.messages, roots)) return undefined;
        appendUserTag(event.messages, renderTag(roots));
        return { messages: event.messages };
    };
}

function renderTag(roots: readonly string[]): string {
    return `<associated_workspaces>\n${roots.join("\n")}\n</associated_workspaces>`;
}

/**
 * True when the window already carries a tag naming exactly these roots.
 *
 * Compared as a SET, not as text: the same directories in a different order
 * are the same association, and re-appending for a reorder would churn the
 * context tail for no change in meaning.
 */
function hasSameRoots(messages: ReadonlyArray<AgentMessage>, roots: readonly string[]): boolean {
    for (const msg of messages) {
        const content = (msg as { content?: unknown }).content;
        const text =
            typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? (content as { text?: string }[]).map((b) => b.text ?? "").join("")
                  : "";
        if (!text.includes("<associated_workspaces")) continue;
        for (const match of findBalancedTagsSkippingFences(text, "associated_workspaces")) {
            const existing = match.inner
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            if (existing.length === roots.length && existing.every((r) => roots.includes(r))) {
                return true;
            }
        }
    }
    return false;
}
