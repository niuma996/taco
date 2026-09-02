import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerPush } from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import {
    chunkText,
    extractReplyText,
    interruptNoticeText,
} from "../../src/channels/builtin/channelReply.ts";

function eventFrame(message: unknown, type = "message_end"): ServerPush {
    return {
        method: PushMethods.Event,
        workspace: "im://wechat/u1/u1",
        session: "s1",
        params: { event: { type, message } },
    } as unknown as ServerPush;
}

describe("extractReplyText", () => {
    it("returns assistant text blocks joined", () => {
        const frame = eventFrame({
            role: "assistant",
            content: [
                { type: "text", text: "Hello " },
                { type: "text", text: "world" },
            ],
        });
        assert.equal(extractReplyText(frame), "Hello world");
    });

    it("returns undefined when the assistant content is not a block array", () => {
        // pi-ai 0.83+ always emits AssistantMessage.content as ProtocolContentBlock[].
        // A non-array (e.g. a bare string from an older adapter or a stray null)
        // is treated as "unknown shape" and skipped — no text reaches the peer.
        assert.equal(extractReplyText(eventFrame({ role: "assistant", content: "hi" })), undefined);
        assert.equal(extractReplyText(eventFrame({ role: "assistant", content: null })), undefined);
    });

    it("drops thinking blocks", () => {
        const frame = eventFrame({
            role: "assistant",
            content: [
                { type: "thinking", thinking: "internal reasoning" },
                { type: "text", text: "answer" },
            ],
        });
        assert.equal(extractReplyText(frame), "answer");
    });

    it("drops toolCall blocks", () => {
        const frame = eventFrame({
            role: "assistant",
            content: [
                { type: "toolCall", id: "t1", name: "read", arguments: {} },
                { type: "text", text: "done" },
            ],
        });
        assert.equal(extractReplyText(frame), "done");
    });

    it("returns undefined when only non-text blocks are present", () => {
        const frame = eventFrame({
            role: "assistant",
            content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
        });
        assert.equal(extractReplyText(frame), undefined);
    });

    it("ignores user messages", () => {
        const frame = eventFrame({
            role: "user",
            content: [{ type: "text", text: "my question" }],
        });
        assert.equal(extractReplyText(frame), undefined);
    });

    it("ignores non-message_end events", () => {
        const frame = eventFrame(
            { role: "assistant", content: [{ type: "text", text: "partial" }] },
            "message_start",
        );
        assert.equal(extractReplyText(frame), undefined);
    });

    it("ignores non-session.event push methods", () => {
        const frame = {
            method: PushMethods.ToolCallStart,
            workspace: "im://wechat/u1/u1",
            session: "s1",
            params: {
                event: { type: "message_end", message: { role: "assistant", content: "x" } },
            },
        } as unknown as ServerPush;
        assert.equal(extractReplyText(frame), undefined);
    });

    it("returns undefined for whitespace-only text", () => {
        assert.equal(
            extractReplyText(eventFrame({ role: "assistant", content: "   " })),
            undefined,
        );
    });

    it("returns the text of an im.tools_enabled frame", () => {
        const frame = {
            method: PushMethods.ImToolsEnabled,
            workspace: "im://wechat/u1/u1",
            session: undefined,
            params: { text: "此对话已启用本地工具。" },
        } as unknown as ServerPush;
        assert.equal(extractReplyText(frame), "此对话已启用本地工具。");
    });

    it("returns undefined for an im.tools_enabled frame without text", () => {
        const frame = {
            method: PushMethods.ImToolsEnabled,
            workspace: "im://wechat/u1/u1",
            session: undefined,
            params: { text: "   " },
        } as unknown as ServerPush;
        assert.equal(extractReplyText(frame), undefined);
    });
});

describe("interruptNoticeText", () => {
    it("returns a short, actionable notice", () => {
        const text = interruptNoticeText();
        assert.ok(text.length > 0 && text.length <= 300);
        assert.match(text, /policy change/i);
    });
});

describe("chunkText", () => {
    it("returns a single chunk when under the cap", () => {
        assert.deepEqual(chunkText("short", 100), ["short"]);
    });

    it("splits on paragraph boundaries first", () => {
        const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
        const chunks = chunkText(text, 40);
        assert.deepEqual(chunks, ["a".repeat(30), "b".repeat(30)]);
    });

    it("splits on a space when no newline fits", () => {
        const chunks = chunkText(`${"a".repeat(20)} ${"b".repeat(20)}`, 25);
        assert.deepEqual(chunks, ["a".repeat(20), "b".repeat(20)]);
    });

    it("hard-splits a token longer than the cap rather than dropping it", () => {
        const chunks = chunkText("x".repeat(25), 10);
        assert.deepEqual(chunks, ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    });

    it("never emits a chunk over the cap", () => {
        const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
        for (const chunk of chunkText(text, 40)) {
            assert.ok(chunk.length <= 40, `chunk too long: ${chunk.length}`);
        }
    });

    it("preserves all content across chunks", () => {
        const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
        const joined = chunkText(text, 25).join(" ");
        assert.equal(joined, text);
    });
});
