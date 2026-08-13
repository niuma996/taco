/**
 * factExtractor — serializer + JSON coercion + merge.
 *
 * The LLM call path (`extractFacts`) is best validated end-to-end against a
 * fake `Models`, but it requires a `Model<unknown>` argument that pi-ai's
 * interface doesn't expose in a vacuum. We keep these tests focused on:
 *   - `serializeMessagesForFacts` — text round-trip
 *   - `mergeFacts`               — dedup semantics
 *   - `EMPTY_FACTS` shape        — frozen
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
    EMPTY_FACTS,
    type FactSet,
    mergeFacts,
    serializeMessagesForFacts,
} from "../../src/tags/factExtractor.ts";

// Tests intentionally cast through `unknown` so we can hand-craft minimal
// AgentMessage-like shapes. The real serializer is tolerant on shape.
const mk = (m: Record<string, unknown>): AgentMessage => m as unknown as AgentMessage;

describe("serializeMessagesForFacts", () => {
    it("renders role + content for string messages", () => {
        const out = serializeMessagesForFacts([
            mk({ role: "user", content: "hi" }),
            mk({ role: "assistant", content: "yo" }),
        ]);
        assert.match(out, /\[user\]\nhi/);
        assert.match(out, /\[assistant\]\nyo/);
    });

    it("renders text blocks of block-array content", () => {
        const out = serializeMessagesForFacts([
            mk({
                role: "assistant",
                content: [
                    { type: "text", text: "hello" },
                    { type: "text", text: "world" },
                ],
            }),
        ]);
        assert.match(out, /hello\nworld/);
    });

    it("ignores unknown / non-text blocks", () => {
        const out = serializeMessagesForFacts([
            mk({
                role: "assistant",
                content: [
                    { type: "text", text: "before" },
                    // not a text block — must NOT crash, must NOT render
                    { type: "image", image: "fake" },
                    { type: "text", text: "after" },
                ],
            }),
        ]);
        assert.match(out, /before.*after/s);
        assert.equal(out.includes("image"), false);
    });

    it("handles messages with non-content gracefully", () => {
        // Cast so we can omit fields that real AgentMessages would carry.
        const out = serializeMessagesForFacts([mk({ role: "user" })]);
        assert.match(out, /\[user\]/);
    });

    it("returns empty string for empty input", () => {
        assert.equal(serializeMessagesForFacts([]), "");
    });
});

describe("mergeFacts", () => {
    it("dedupes decisions and constraints by `text` (later wins)", () => {
        const a: FactSet = {
            decisions: [{ text: "Use Postgres", evidence: "1" }],
            constraints: [{ text: "Don't write prod DB directly", evidence: "2" }],
            entities: [],
        };
        const b: FactSet = {
            decisions: [{ text: "Use Postgres", evidence: "later turn" }],
            constraints: [
                { text: "Don't write prod DB directly", evidence: "earlier" },
                { text: "Max 5 concurrent jobs", evidence: "3" },
            ],
            entities: [{ name: "CI", type: "system", note: "GitHub Actions" }],
        };
        const merged = mergeFacts(a, b);
        assert.equal(merged.decisions.length, 1);
        assert.equal(merged.decisions[0]?.evidence, "later turn");
        assert.equal(merged.constraints.length, 2);
        const texts = merged.constraints.map((c) => c.text).sort();
        assert.deepEqual(texts, ["Don't write prod DB directly", "Max 5 concurrent jobs"]);
        assert.equal(merged.entities.length, 1);
        assert.equal(merged.entities[0]?.name, "CI");
    });

    it("dedupes entities by `name|type`", () => {
        const a: FactSet = {
            decisions: [],
            constraints: [],
            entities: [{ name: "DB", type: "system", note: "v14" }],
        };
        const b: FactSet = {
            decisions: [],
            constraints: [],
            entities: [
                { name: "DB", type: "system", note: "v15" },
                { name: "DB", type: "alias", note: "primary db" },
            ],
        };
        const merged = mergeFacts(a, b);
        assert.equal(merged.entities.length, 2);
        const db = merged.entities.find((e) => e.name === "DB" && e.type === "system");
        assert.equal(db?.note, "v15");
    });

    it("is idempotent on EMPTY_FACTS input", () => {
        const facts: FactSet = {
            decisions: [{ text: "D", evidence: "e" }],
            constraints: [{ text: "C", evidence: "e" }],
            entities: [{ name: "X", type: "t", note: "n" }],
        };
        const merged = mergeFacts(EMPTY_FACTS, facts);
        assert.equal(merged.decisions.length, 1);
        assert.equal(merged.constraints.length, 1);
        assert.equal(merged.entities.length, 1);
    });
});
