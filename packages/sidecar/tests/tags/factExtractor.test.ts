/**
 * factExtractor — transcript serializer used by the memory extractor.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { serializeMessagesForFacts } from "../../src/tags/factExtractor.ts";

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
                    { type: "image", image: "fake" },
                    { type: "text", text: "after" },
                ],
            }),
        ]);
        assert.match(out, /before.*after/s);
        assert.equal(out.includes("image"), false);
    });

    it("handles messages with non-content gracefully", () => {
        const out = serializeMessagesForFacts([mk({ role: "user" })]);
        assert.match(out, /\[user\]/);
    });

    it("returns empty string for empty input", () => {
        assert.equal(serializeMessagesForFacts([]), "");
    });
});
