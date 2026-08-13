/**
 * extractAndStripPinned + buildPinnedTail unit tests.
 *
 * Pin policy: when the registry marks a tag with `compression={kind:'pin'}`,
 * the segment must (1) be extracted verbatim and (2) be removed from the
 * original message body so it doesn't get double-counted when the tail block
 * is re-appended. These tests pin the dedup + strip behavior.
 *
 * No new dependencies — `node:test` + `node:assert` only.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { extractAndStripPinned, extractPinnedSegments } from "../../src/tags/extractors.ts";
import { buildPinnedDirective, buildPinnedTail } from "../../src/tags/policy/compression.ts";

interface TaggedMsg {
    readonly role: "user" | "assistant";
    readonly content: string;
}

describe("extractAndStripPinned", () => {
    it("strips a single pinned tag and returns its content verbatim", () => {
        const messages: TaggedMsg[] = [
            {
                role: "user",
                content:
                    'preamble\n<skill_body name="rule">NEVER touch prod DB</skill_body>\npostamble',
            },
        ];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 1);
        assert.equal(result.pinned[0]?.name, "skill_body");
        assert.equal(result.pinned[0]?.content, "NEVER touch prod DB");
        const out = result.strippedMessages[0];
        assert.ok(out);
        assert.equal(out.content.includes("skill_body"), false);
        assert.equal(out.content.includes("NEVER touch prod DB"), false);
        assert.equal(out.content.includes("preamble"), true);
        assert.equal(out.content.includes("postamble"), true);
    });

    it("keeps first-seen only across messages; strips ALL occurrences", () => {
        const messages: TaggedMsg[] = [
            { role: "user", content: '<skill_body name="x">v1</skill_body> alpha' },
            { role: "user", content: 'beta <skill_body name="x">v2</skill_body> gamma' },
        ];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 1);
        assert.equal(result.pinned[0]?.content, "v1");
        assert.equal(result.strippedMessages[0]?.content.includes("v1"), false);
        assert.equal(result.strippedMessages[1]?.content.includes("v2"), false);
        assert.equal(result.strippedMessages[0]?.content.includes("alpha"), true);
        assert.equal(result.strippedMessages[1]?.content.includes("beta"), true);
        assert.equal(result.strippedMessages[1]?.content.includes("gamma"), true);
    });

    it("leaves non-pinned tags untouched", () => {
        const messages: TaggedMsg[] = [{ role: "user", content: "<not_a_pin>hello</not_a_pin>" }];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 0);
        // not_a_pin isn't in the registry as pin → stays in place.
        assert.equal(result.strippedMessages[0]?.content, "<not_a_pin>hello</not_a_pin>");
    });

    it("ignores tags inside fenced code blocks", () => {
        // The `<skill_body>...</skill_body>` inside the fenced block
        // must NOT be picked up — `findBalancedTagsSkippingFences` is the parser.
        const fenced = '```\n<skill_body name="s">SECRET</skill_body>\n```';
        const real = '<skill_body name="s">REAL</skill_body>';
        const messages: TaggedMsg[] = [{ role: "user", content: `${fenced}\n${real}` }];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 1);
        assert.equal(result.pinned[0]?.content, "REAL");
        // The fenced body should still be present (it's just a markdown fence).
        assert.equal(result.strippedMessages[0]?.content.includes("SECRET"), true);
        assert.equal(result.strippedMessages[0]?.content.includes("REAL"), false);
    });

    it("preserves messages with non-string content unchanged", () => {
        const messages = [{ role: "user" as const, content: 42 }];
        const result = extractAndStripPinned(messages);
        assert.equal(result.pinned.length, 0);
        assert.deepEqual(result.strippedMessages[0], { role: "user", content: 42 });
    });
});

describe("extractPinnedSegments (read-only)", () => {
    it("returns pinned segments without stripping", () => {
        const text = '<skill_body name="a">A</skill_body> x <ask_user_context>B</ask_user_context>';
        const messages = [
            { role: "user" as const, content: text },
            { role: "user" as const, content: text },
        ];
        const segments = extractPinnedSegments(messages);
        const names = segments.map((s) => s.name).sort();
        assert.deepEqual(names, ["ask_user_context", "skill_body"]);
        // Read-only: original messages must NOT be modified.
        for (const m of messages) {
            assert.ok((m.content as string).includes("<skill_body"));
        }
    });
});

describe("buildPinnedTail", () => {
    it("returns empty string when no segments", () => {
        assert.equal(buildPinnedTail([]), "");
    });

    it("wraps each pinned segment with its tag and a sentinel header", () => {
        const tail = buildPinnedTail([
            {
                name: "instructions",
                content: "follow",
                attrs: {},
                instanceId: "instructions:test",
            },
        ]);
        assert.match(tail, /PINNED \(verbatim/);
        // tagWrap emits `<name>\nbody\n</name>` — accept either exact or with newlines.
        assert.match(tail, /<instructions>\s*\n?follow\n?\s*<\/instructions>/);
    });

    it("preserves tag attributes from the original pinned segment", () => {
        const tail = buildPinnedTail([
            {
                name: "skill_body",
                content: "body",
                attrs: { name: "fix" },
                instanceId: "skill_body:fix",
            },
        ]);
        assert.match(tail, /<skill_body name="fix">\s*\n?body\n?\s*<\/skill_body>/);
    });
});

describe("buildPinnedDirective", () => {
    it("returns null when no tag names", () => {
        assert.equal(buildPinnedDirective([]), null);
    });

    it("lists tag names in the do-not-paraphrase directive", () => {
        const text = buildPinnedDirective(["skill_body", "ask_user_context"]);
        assert.ok(text);
        assert.ok(text.includes("skill_body"));
        assert.ok(text.includes("ask_user_context"));
        assert.ok(text.toLowerCase().includes("do not"));
    });
});
