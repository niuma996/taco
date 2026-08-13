/**
 * reply_language tag — unit tests.
 *
 * Run: pnpm --filter @taco-ai/sidecar test:reply
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildReplyLanguageContextHook } from "../../src/tags/replyLanguage.ts";

function makeUserMessage(text: string): AgentMessage {
    return {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
    };
}

describe("buildReplyLanguageContextHook", () => {
    function firstText(msg: AgentMessage): string {
        assert.equal(msg.role, "user", "expected user message");
        const content = (msg as { content: { type: "text"; text: string }[] }).content;
        return content[0].text;
    }

    it("emits a <reply_language> tag when the getter returns a locale", () => {
        const hook = buildReplyLanguageContextHook(() => "zh");
        const event = { messages: [makeUserMessage("hello")] };
        const result = hook(event);

        assert.ok(result);
        assert.equal(result.messages.length, 2);
        const tagMsg = result.messages[0];
        assert.ok(tagMsg);
        const text = firstText(tagMsg);
        assert.match(text, /^<reply_language>/);
        assert.match(text, /Always reply in Chinese/);
        assert.match(text, /<\/reply_language>$/);
    });

    it("passes messages through unchanged when the getter returns undefined", () => {
        const hook = buildReplyLanguageContextHook(() => undefined);
        const event = { messages: [makeUserMessage("hi"), makeUserMessage("there")] };
        const result = hook(event);
        assert.equal(result, undefined);
    });

    it("reads the getter on every call (per-turn dynamic)", () => {
        let current: "zh" | "en" | undefined = "zh";
        const hook = buildReplyLanguageContextHook(() => current);

        const resultZh = hook({ messages: [makeUserMessage("x")] });
        assert.ok(resultZh);
        const tagZh = resultZh.messages[0];
        assert.ok(tagZh);
        assert.match(firstText(tagZh), /Chinese/);

        current = "en";
        const resultEn = hook({ messages: [makeUserMessage("x")] });
        assert.ok(resultEn);
        const tagEn = resultEn.messages[0];
        assert.ok(tagEn);
        assert.match(firstText(tagEn), /English/);
    });

    it("places the tag BEFORE the original messages AND mutates the input array in place", () => {
        const hook = buildReplyLanguageContextHook(() => "en");
        const userMsg = makeUserMessage("user msg");
        const original = [userMsg];
        const result = hook({ messages: original });
        assert.ok(result);
        // New contract: hook mutates `event.messages` in place (required by
        // pi-agent-core's last-writer-wins emitHook semantics) and returns
        // the same array reference. The original array must now hold the tag.
        assert.equal(result.messages, original, "result.messages must be the same reference");
        assert.equal(original.length, 2, "input array must be mutated to length 2");
        assert.equal(original[1], userMsg);
    });
});
