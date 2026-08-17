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
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";
import {
    EMPTY_FACTS,
    extractFacts,
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

/**
 * `extractFacts` — pin-aware compaction's LLM call. Like memory extraction,
 * this sits outside the harness streamOptions, so the tag must be passed
 * explicitly. Regression: an earlier refactor that dropped `headers:`
 * would have surfaced at the provider as `Nr/JS <ver>` instead of
 * `taco/<ver>` for every compaction.
 *
 * `Model<any>` is what pi-agent-core exposes for `completeSimple`; we
 * cast the minimal stub the same way the real extractor.ts does.
 */
describe("extractFacts — taco headers on the fact-extraction LLM call", () => {
    it("forwards tacoRequestHeaders to models.completeSimple", async () => {
        const version = sidecarVersion();
        let capturedOptions: { headers?: Record<string, string> } | undefined;

        // biome-ignore lint/suspicious/noExplicitAny: mirrors factExtractor.ts, which re-exposes `Model<any>` from pi-agent-core's `completeSimple`.
        const fakeModel = {} as Model<any>;
        const fakeModels = {
            completeSimple: async (
                _model: Model<Api>,
                _context: unknown,
                options?: { headers?: Record<string, string> },
            ) => {
                capturedOptions = options;
                return {
                    role: "assistant",
                    content: [{ type: "text", text: "{}" }],
                };
            },
        } as unknown as Models;

        const messages: AgentMessage[] = [
            mk({ role: "user", content: "remember the project name is taco" }),
            mk({ role: "assistant", content: "got it" }),
        ];

        await extractFacts(messages, fakeModels, fakeModel);

        assert.ok(capturedOptions, "completeSimple should have been called");
        assert.equal(capturedOptions.headers?.["user-agent"], `taco/${version}`);
        assert.equal(capturedOptions.headers?.["x-taco-sidecar-version"], version);
    });

    it("returns EMPTY_FACTS (does not throw) on LLM failure", async () => {
        // biome-ignore lint/suspicious/noExplicitAny: mirrors factExtractor.ts, which re-exposes `Model<any>` from pi-agent-core's `completeSimple`.
        const fakeModel = {} as Model<any>;
        const fakeModels = {
            completeSimple: async () => {
                throw new Error("network down");
            },
        } as unknown as Models;

        const messages: AgentMessage[] = [mk({ role: "user", content: "hi" })];
        const out = await extractFacts(messages, fakeModels, fakeModel);
        assert.deepEqual(out, EMPTY_FACTS);
    });
});
