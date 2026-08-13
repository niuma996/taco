/**
 * `memory` tag — context hook.
 *
 * Reads MEMORY.md on every LLM context build and injects it as a
 * `<memory>...</memory>` user message at the front.
 *
 * With PinOnceConsumer, skips injection if the memory's instanceId was
 * already consumed by a prior compaction — the verbatim content is in the
 * CompactionEntry summary. A failing read MUST NOT fail the LLM call.
 */

import { createHash } from "node:crypto";
import type { ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import { createLogger } from "../lib/logger.ts";
import type { PinOnceConsumer } from "../runtime/pinOnceConsumer.ts";
import { createUserMessage, tagWrap } from "../tags/builder.ts";
import type { MemoryStore } from "./types.ts";

const log = createLogger("memory:hook");

/**
 * Build a `context` hook that prepends a `<memory>` user message to every
 * LLM call's context window, unless a PinOnceConsumer reports the instance
 * has already been consumed.
 *
 * Returns an empty function when MEMORY.md is empty or unreadable.
 */
export function buildMemoryContextHook(
    store: MemoryStore,
    pinOnceConsumer?: PinOnceConsumer,
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

        const instanceId = `memory:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
        if (pinOnceConsumer?.isConsumed(instanceId)) {
            return undefined;
        }

        const wrapped = tagWrap("memory", content);
        event.messages.unshift(createUserMessage(wrapped));
        return { messages: event.messages };
    };
}
