/**
 * `reply_language` tag — context hook. Each LLM context build calls `getUiLocale()`
 * and prepends a `<reply_language>` tag if set; otherwise pass-through.
 * Locale is held by AttachedSession; per-turn handlers update it so language
 * switches take effect without re-attaching.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { SupportedLocale } from "@taco-ai/protocol";

import { createUserMessage, tagWrap } from "./builder.ts";

const LOCALE_DISPLAY: Record<SupportedLocale, string> = {
    zh: "Chinese",
    en: "English",
};

/**
 * Build a `context` hook that injects a `<reply_language>` tag whenever the
 * getter returns a locale. Reads the getter on every invocation (per-turn dynamic).
 */
export function buildReplyLanguageContextHook(
    getUiLocale: () => SupportedLocale | undefined,
): (event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined {
    return (event: { messages: AgentMessage[] }) => {
        const locale = getUiLocale();
        if (!locale) return undefined;
        const display = LOCALE_DISPLAY[locale];
        const body = `Always reply in ${display}, regardless of the language the user types in.`;
        event.messages.unshift(createUserMessage(tagWrap("reply_language", body)));
        return { messages: event.messages };
    };
}
