/**
 * `cleanTitle` — LLM output → clamped title string. Pure, no I/O.
 * `TitleSummarizer.onRunEnd` — fire-and-forget LLM call at (session's first)
 * run_end, gated by token threshold, tagged with tacoRequestHeaders.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { asSessionId } from "@taco-ai/protocol";
import type { AgentMessage, Api, Model, Models, TextContent } from "../../src/runtime/pi/types.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";
import { cleanTitle, TitleSummarizer } from "../../src/runtime/session/titleSummarizer.ts";

describe("cleanTitle", () => {
    it("passes through a clean short title unchanged", () => {
        assert.equal(cleanTitle("Fix login bug"), "Fix login bug");
    });

    it("strips surrounding double quotes", () => {
        assert.equal(cleanTitle('"Fix login bug"'), "Fix login bug");
    });

    it("strips surrounding markdown emphasis", () => {
        assert.equal(cleanTitle("**Fix login bug**"), "Fix login bug");
    });

    it("collapses internal whitespace/newlines", () => {
        assert.equal(cleanTitle("Fix   login\n\nbug"), "Fix login bug");
    });

    it("trims trailing punctuation the model sometimes adds", () => {
        assert.equal(cleanTitle("Fix login bug."), "Fix login bug");
        assert.equal(cleanTitle("修复登录问题。"), "修复登录问题");
    });

    it("clamps to 20 grapheme clusters, not UTF-16 code units", () => {
        const raw = "a".repeat(30);
        assert.equal(cleanTitle(raw).length, 20);
    });

    it("clamps CJK text by character count, matching the ASCII cap", () => {
        const raw = "修".repeat(25);
        const out = cleanTitle(raw);
        assert.equal(Array.from(out).length, 20);
    });

    it("clamping a surrogate-pair emoji does not split it into an unpaired half", () => {
        // 21 emoji graphemes (each a surrogate pair) — clamped to 20 must drop
        // whole graphemes, never leave a lone high/low surrogate dangling.
        const raw = "😀".repeat(21);
        const out = cleanTitle(raw);
        assert.equal(Array.from(out).length, 20);
        // A dangling surrogate would make this string invalid / mismatched
        // length under a code-point re-split; assert round-trip stability.
        assert.equal(Array.from(out).join(""), out);
    });

    it("returns empty string for input that is only quotes/whitespace", () => {
        assert.equal(cleanTitle('   "  "   '), "");
    });
});

function fakeMessage(text: string): AgentMessage {
    return {
        role: "user",
        content: text,
        timestamp: Date.now(),
    } as unknown as AgentMessage;
}

// Long enough to clear MIN_TOKEN_THRESHOLD (30 tokens ~= 120 chars).
const LONG_CONVERSATION = "user: " + "please help me debug this login redirect issue ".repeat(6);

describe("TitleSummarizer.onRunEnd", () => {
    it("calls setSummaryTitle with the cleaned model output", async () => {
        const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
        const fakeModels = {
            completeSimple: async () => ({
                role: "assistant",
                content: [{ type: "text", text: '"Fix login bug."' } satisfies TextContent],
            }),
        } as unknown as Models;

        let captured: { sessionId: string; name: string } | undefined;
        const setSummaryTitle = async (sessionId: string, name: string) => {
            captured = { sessionId, name };
            return true;
        };

        const sessionId = asSessionId("s-1");
        const summarizer = new TitleSummarizer(fakeModels, fakeModel, sessionId, setSummaryTitle);
        await summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]);

        assert.deepEqual(captured, { sessionId: "s-1", name: "Fix login bug" });
    });

    it("skips the LLM call entirely below the token threshold", async () => {
        let called = false;
        const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
        const fakeModels = {
            completeSimple: async () => {
                called = true;
                return { role: "assistant", content: [] };
            },
        } as unknown as Models;

        const summarizer = new TitleSummarizer(
            fakeModels,
            fakeModel,
            asSessionId("s-1"),
            async () => true,
        );
        await summarizer.onRunEnd([fakeMessage("hi")]);

        assert.equal(called, false);
    });

    it("does not call setSummaryTitle when the model returns empty text", async () => {
        let called = false;
        const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
        const fakeModels = {
            completeSimple: async () => ({ role: "assistant", content: [] }),
        } as unknown as Models;

        const summarizer = new TitleSummarizer(
            fakeModels,
            fakeModel,
            asSessionId("s-1"),
            async () => {
                called = true;
                return true;
            },
        );
        await summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]);

        assert.equal(called, false);
    });

    it("never throws when the LLM call rejects — fire-and-forget", async () => {
        const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
        const fakeModels = {
            completeSimple: async () => {
                throw new Error("provider unavailable");
            },
        } as unknown as Models;

        const summarizer = new TitleSummarizer(
            fakeModels,
            fakeModel,
            asSessionId("s-1"),
            async () => true,
        );
        await assert.doesNotReject(() => summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]));
    });

    it("never throws when setSummaryTitle itself rejects", async () => {
        const fakeModel = { provider: "test", id: "m" } as unknown as Model<Api>;
        const fakeModels = {
            completeSimple: async () => ({
                role: "assistant",
                content: [{ type: "text", text: "Fix login bug" } satisfies TextContent],
            }),
        } as unknown as Models;

        const summarizer = new TitleSummarizer(
            fakeModels,
            fakeModel,
            asSessionId("s-1"),
            async () => {
                throw new Error("session closed mid-write");
            },
        );
        await assert.doesNotReject(() => summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]));
    });
});

/**
 * `TitleSummarizer.onRunEnd` — taco headers on the summarization LLM call.
 * Same regression this pins for MemoryExtractorImpl: this call sits OUTSIDE
 * the harness streamOptions (which is where `withTacoUserAgent` attaches the
 * taco tag for main conversation turns), so a missing header here would
 * surface at the provider as the bundled sidecar's mangled default user agent.
 */
describe("TitleSummarizer — taco headers on the summarization LLM call", () => {
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
                return {
                    role: "assistant",
                    content: [{ type: "text", text: "Fix login bug" } satisfies TextContent],
                };
            },
        } as unknown as Models;

        const summarizer = new TitleSummarizer(
            fakeModels,
            fakeModel,
            asSessionId("s-1"),
            async () => true,
        );
        await summarizer.onRunEnd([fakeMessage(LONG_CONVERSATION)]);

        assert.ok(capturedOptions, "completeSimple should have been called");
        assert.ok(capturedOptions?.headers?.["user-agent"]?.includes(version));
    });
});
