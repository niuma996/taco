/**
 * `env` tag — context hook.
 *
 * Injects an `<env>` tag carrying the current local time into every LLM
 * context. `cwd` is not repeated here: the system prompt's `<project_context>`
 * already states the working directory, and `<platform>` already names the
 * shell — both inside the cacheable prefix.
 *
 * Integration: `harness.on("context", buildEnvContextHook())`
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createUserMessage, tagWrap } from "./builder.ts";

/** Format current local date/time (with weekday) as a readable string. Minute
 *  precision — stable enough that consecutive turns within the same minute
 *  share the same value. The weekday lets the model resolve relative dates
 *  ("next Friday") without guessing. */
function formatNow(): string {
    return new Date().toLocaleString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

/**
 * Build a `context` hook that injects an `<env>` tag carrying only the current
 * local time. Injected as the LAST user message so it does not grow the stable
 * conversation prefix turn-over-turn — keeping upstream prefix stable for
 * both pi's `estimateContextTokens` heuristic on prior turns and provider-side
 * prompt cache. The env tag at the very end sits outside the cacheable region;
 * the real reason env goes here is to keep the messages array's stable
 * portion stable.
 */
export function buildEnvContextHook(): (event: { messages: AgentMessage[] }) => {
    messages: AgentMessage[];
} {
    return (event: { messages: AgentMessage[] }): { messages: AgentMessage[] } => {
        event.messages.push(createUserMessage(tagWrap("env", `local_time: ${formatNow()}`)));
        return { messages: event.messages };
    };
}
