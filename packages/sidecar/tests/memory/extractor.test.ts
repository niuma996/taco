/**
 * `parseExtractionResult` — LLM output → MemoryEntry[] parser. Pure, no I/O.
 * Regression coverage: markdown fences, non-JSON prose, missing/invalid fields,
 * field length limits, id normalisation, stable synthetic id generation.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";

import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";
import { MemoryExtractorImpl, parseExtractionResult } from "../../src/memory/local/extractor.ts";

describe("parseExtractionResult", () => {
    const createdAt = "2026-07-26T00:00:00.000Z";
    const ws = "ws-1";

    it("parses a clean JSON array", () => {
        const raw = JSON.stringify([
            { id: "u1", name: "User role", type: "user", content: "admin" },
            { id: "p1", name: "Project", type: "project", content: "taco" },
        ]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out.length, 2);
        assert.equal(out[0]?.id, "u1");
        assert.equal(out[1]?.type, "project");
    });

    it("strips ```json fences", () => {
        const raw = '```json\n[{"name":"x","type":"user"}]\n```';
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out.length, 1);
        assert.equal(out[0]?.name, "x");
    });

    it("ignores surrounding prose", () => {
        const raw = 'Here is the result:\n[{"name":"x","type":"user"}]\nDone.';
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out.length, 1);
    });

    it("returns [] on non-JSON", () => {
        assert.deepEqual(parseExtractionResult("just text", createdAt, ws), []);
        assert.deepEqual(parseExtractionResult("{not an array}", createdAt, ws), []);
    });

    it("drops entries with missing name or type", () => {
        const raw = JSON.stringify([
            { name: "ok", type: "user" },
            { name: "no-type" },
            { type: "user" },
            {},
        ]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out.length, 1);
        assert.equal(out[0]?.name, "ok");
    });

    it("drops entries with invalid type (no longer coerces to 'fact')", () => {
        const raw = JSON.stringify([
            { name: "valid", type: "user" },
            { name: "bad", type: "fact" }, // not in MEMORY_ENTRY_TYPES
            { name: "another", type: "memory" }, // also not valid
        ]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out.length, 1);
        assert.equal(out[0]?.name, "valid");
    });

    it("normalises id: lowercase, spaces to _, strips non-alphanumerics", () => {
        // Pipeline: lowercase → spaces→_ → strip non-[a-z0-9_].
        // Trailing space becomes trailing _ (kept because _ is alphanumeric).
        const raw = JSON.stringify([{ id: "User Role @#$", name: "n", type: "user" }]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out[0]?.id, "user_role_");
    });

    it("synthesises id when missing", () => {
        const raw = JSON.stringify([
            { name: "first", type: "user" },
            { name: "second", type: "user" },
        ]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.ok(out[0]?.id.startsWith("mem-"));
        assert.ok(out[1]?.id.startsWith("mem-"));
        assert.notEqual(out[0]?.id, out[1]?.id);
    });

    it("truncates fields to declared limits", () => {
        const longName = "x".repeat(200);
        const longDesc = "y".repeat(300);
        const longContent = "z".repeat(MEMORY_CONTENT_MAX_CHARS * 2);
        const raw = JSON.stringify([
            { name: longName, description: longDesc, content: longContent, type: "user" },
        ]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out[0]?.name.length, 60);
        assert.equal(out[0]?.description.length, 120);
        assert.equal(out[0]?.content.length, MEMORY_CONTENT_MAX_CHARS);
    });

    it("defaults description and content to name when missing", () => {
        const raw = JSON.stringify([{ id: "x", name: "fallback", type: "user" }]);
        const out = parseExtractionResult(raw, createdAt, ws);
        assert.equal(out[0]?.description, "fallback");
        assert.equal(out[0]?.content, "fallback");
    });

    it("propagates createdAt and workspaceId to every entry", () => {
        const raw = JSON.stringify([
            { id: "a", name: "A", type: "user" },
            { id: "b", name: "B", type: "feedback" },
        ]);
        const out = parseExtractionResult(raw, createdAt, ws);
        for (const e of out) {
            assert.equal(e.createdAt, createdAt);
            assert.equal(e.workspaceId, ws);
        }
    });
});

/**
 * `MemoryExtractorImpl.extract` — fire-and-forget LLM call at turn_end.
 * This call sits OUTSIDE the harness streamOptions (which is where
 * `withTacoUserAgent` attaches the taco tag for main conversation
 * turns), so a regression here used to surface at the provider as
 * `Nr/JS <ver>` — the bundled sidecar's mangled default. Pin it.
 */
describe("MemoryExtractorImpl — taco headers on the extraction LLM call", () => {
    it("forwards tacoRequestHeaders to models.completeSimple", async () => {
        const version = sidecarVersion();
        let capturedOptions: { headers?: Record<string, string> } | undefined;

        const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
        const fakeModels = {
            completeSimple: async (
                _model: Model<Api>,
                _context: unknown,
                options?: { headers?: Record<string, string> },
            ) => {
                capturedOptions = options;
                // Return an assistant message with valid JSON so the extractor
                // proceeds past the early return.
                return {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify([{ name: "n", type: "user", content: "c" }]),
                        } satisfies TextContent,
                    ],
                };
            },
        } as unknown as Models;

        const store = { appendEntry: async () => undefined };
        const extractor = new MemoryExtractorImpl(fakeModels, fakeModel, store, "ws-1");

        // Need enough text to clear the 50-token threshold.
        const longConversation =
            "user: " + "this is a memory-worthy conversation ".repeat(20) + "\nassistant: ok";
        await extractor.onTurnEnd([
            { role: "user", content: longConversation } as unknown as Parameters<
                MemoryExtractorImpl["onTurnEnd"]
            >[0][number],
        ]);

        assert.ok(capturedOptions, "completeSimple should have been called");
        assert.equal(capturedOptions.headers?.["user-agent"], `taco/${version}`);
        assert.equal(capturedOptions.headers?.["x-taco-sidecar-version"], version);
    });

    it("does not invoke the LLM when the conversation is below the token gate", async () => {
        let called = false;
        const fakeModels = {
            completeSimple: async () => {
                called = true;
                return undefined;
            },
        } as unknown as Models;
        const fakeModel = {} as Model<Api>;
        const extractor = new MemoryExtractorImpl(fakeModels, fakeModel, { appendEntry: async () => undefined }, "ws-1");

        await extractor.onTurnEnd([{ role: "user", content: "hi" } as unknown as Parameters<
            MemoryExtractorImpl["onTurnEnd"]
        >[0][number]]);

        assert.equal(called, false);
    });
});
