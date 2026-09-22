/**
 * `memory` tag — context hook.
 *
 * Reads MEMORY.md on every LLM context build and injects it as a
 * `<memory source="user">` user message at the tail.
 *
 * Memory is RESIDENT, not pinOnce: pi's `transform_context` hands hooks a
 * per-request copy of the message list, so the tag never persists into
 * session history and compaction never sees it (preparations are built from
 * persisted entries). Re-injection on every build is what keeps memory
 * present across compactions in long IM sessions that roll forever with
 * compaction as the only context management. The registry's `drop` policy
 * records this: no preservation machinery applies.
 *
 * A failing read MUST NOT fail the LLM call.
 */

import type { ContextEvent, ContextResult } from "../extensions/types.ts";
import { createLogger } from "../lib/logger.ts";
import { appendUserTag } from "../tags/appendUserTag.ts";
import { tagWrap } from "../tags/builder.ts";
import type { MemoryStore } from "./types.ts";

const log = createLogger("memory:hook");

/**
 * Build a `context` hook that appends a `<memory>` user message to every
 * LLM call's context window. Append (not unshift) so a skip does not
 * rewrite `messages[0]` and bust the prompt-cache prefix.
 *
 * Returns an empty function when MEMORY.md is empty or unreadable.
 */
export function buildMemoryContextHook(
    store: MemoryStore,
): (event: ContextEvent) => Promise<ContextResult | undefined> {
    return async (event: ContextEvent): Promise<ContextResult | undefined> => {
        let content: string;
        try {
            content = store.buildMemoryBlock();
        } catch (err) {
            log.error("failed to read MEMORY.md:", err);
            return undefined;
        }
        if (!content) return undefined;

        const wrapped = tagWrap("memory", content, { source: "user" });
        appendUserTag(event.messages, wrapped);
        return { messages: event.messages };
    };
}
