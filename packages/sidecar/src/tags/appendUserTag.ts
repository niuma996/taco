/**
 * Append a synthetic user-tag message to the tail of a context window.
 *
 * Live context (instructions, git, env, plan, tasks, …) used to `unshift` onto
 * `messages[0]`. Provider prompt cache keys the prefix from the first user
 * message, so a tag that is sometimes present and sometimes skipped produced
 * a full-prefix miss (`cacheRead ≈ 128`) on the next turn. Append keeps the
 * stable conversation prefix byte-identical across turns; the tag sits
 * outside the cacheable region, same as `<env>`.
 */

import type { AgentMessage } from "../runtime/pi/types.ts";

import { createUserMessage, prefixTagSource, type TagSource } from "./builder.ts";

/**
 * Push `text` as a user message onto `messages` (in-place) and return them.
 * When `source` is provided, the body is prefixed with a source framing so the
 * model knows this is not ordinary user input.
 */
export function appendUserTag(
    messages: AgentMessage[],
    text: string,
    source?: TagSource,
): AgentMessage[] {
    messages.push(createUserMessage(source ? prefixTagSource(text, source) : text));
    return messages;
}
