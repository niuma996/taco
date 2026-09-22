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

import { createUserMessage } from "./builder.ts";

/** Push `text` as a user message onto `messages` (in-place) and return them. */
export function appendUserTag(messages: AgentMessage[], text: string): AgentMessage[] {
    messages.push(createUserMessage(text));
    return messages;
}
