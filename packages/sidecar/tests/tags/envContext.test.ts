/**
 * env tag + static env lines — unit tests.
 *
 * Run: pnpm --filter @taco-ai/sidecar test
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { buildEnvContextHook } from "../../src/tags/envContext.ts";

function textOf(messages: AgentMessage[]): string {
    return messages
        .map((m) => {
            const c = (m as { content?: unknown }).content;
            if (Array.isArray(c))
                return (c as Array<{ text?: string }>).map((b) => b.text).join("");
            return String(c ?? "");
        })
        .join("\n");
}

describe("buildEnvContextHook", () => {
    it("appends an <env> tag carrying only local_time (no cwd/shell)", () => {
        const hook = buildEnvContextHook();
        const event = { messages: [] as AgentMessage[] };
        const result = hook(event);
        const text = textOf(result.messages);
        assert.ok(text.includes("<env>"), "must inject <env>");
        assert.match(text, /local_time:/);
        assert.ok(!text.includes("cwd:"), "cwd moved to the static system prompt");
        assert.ok(!text.includes("shell:"), "shell moved to the static system prompt");
    });

    it("local_time carries the weekday so relative dates resolve", () => {
        const hook = buildEnvContextHook();
        const text = textOf(hook({ messages: [] as AgentMessage[] }).messages);
        const stamp = /local_time: (.+)/.exec(text)?.[1];
        assert.ok(stamp, "local_time must render a value");

        // Locale-agnostic: assert the weekday option took effect by diffing the
        // same instant formatted with and without it. Matching literal weekday
        // names would pin the test to the host ICU locale (and to the weekday
        // being a prefix, which is false for e.g. zh-CN).
        const opts: Intl.DateTimeFormatOptions = {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        };
        const now = new Date();
        const withoutWeekday = now.toLocaleString(undefined, opts);
        const withWeekday = now.toLocaleString(undefined, { ...opts, weekday: "long" });
        assert.notEqual(withWeekday, withoutWeekday, "weekday must add content in this locale");
        assert.ok(
            stamp.length > withoutWeekday.length,
            `stamp must be longer than the weekday-less form (got "${stamp}")`,
        );
    });

    it("pushes to the tail (stable prefix untouched)", () => {
        const hook = buildEnvContextHook();
        const first: AgentMessage = {
            role: "user",
            content: [{ type: "text", text: "first" }],
            timestamp: 0,
        };
        const event = { messages: [first] };
        const result = hook(event);
        assert.equal(result.messages.length, 2);
        assert.ok(textOf([result.messages[0]]).includes("first"), "original stays at head");
        assert.ok(textOf([result.messages[1]]).includes("<env>"), "env goes to the tail");
    });
});
