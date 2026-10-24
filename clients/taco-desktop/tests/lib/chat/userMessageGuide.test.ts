/**
 * userMessageGuide pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop exec tsx --test tests/lib/chat/userMessageGuide.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ImageInput } from "@taco-ai/protocol";

import type { UiMessage } from "../../../src/lib/chat/chatUtils";
import { buildUserMessageGuide } from "../../../src/lib/chat/userMessageGuide";

const IMAGE: ImageInput = { type: "image", data: "AAAA", mimeType: "image/png" };

function user(id: string, text: string, images?: ImageInput[]): UiMessage {
    return { id, kind: "user", text, ts: 0, images };
}

describe("buildUserMessageGuide — 条目抽取", () => {
    it("只保留 user 行，并保留原始绝对索引", () => {
        const messages: UiMessage[] = [
            { id: "a0", kind: "assistant", text: "hi", ts: 0, tools: [], thinking: [] },
            user("u1", "hello"),
            user("u2", "", [IMAGE]),
            user("u3", "after"),
        ];

        assert.deepEqual(buildUserMessageGuide(messages), [
            { id: "u1", messageIndex: 1, text: "hello", images: [] },
            { id: "u2", messageIndex: 2, text: "", images: [IMAGE] },
            { id: "u3", messageIndex: 3, text: "after", images: [] },
        ]);
    });

    it("assistant / tool / system 行不产生条目", () => {
        const messages: UiMessage[] = [
            { id: "a0", kind: "assistant", text: "hi", ts: 0, tools: [], thinking: [] },
            { id: "t0", kind: "tool", text: "tool output", ts: 0 },
            { id: "s0", kind: "system", text: "system note", ts: 0 },
        ];

        assert.deepEqual(buildUserMessageGuide(messages), []);
    });

    it("没有 user 消息时返回空数组", () => {
        assert.deepEqual(buildUserMessageGuide([]), []);
    });

    it("索引在跳过其它角色后仍然是绝对索引", () => {
        const messages: UiMessage[] = [
            { id: "a0", kind: "assistant", text: "hi", ts: 0, tools: [], thinking: [] },
            { id: "t0", kind: "tool", text: "tool output", ts: 0 },
            user("u1", "hello"),
            { id: "s0", kind: "system", text: "system note", ts: 0 },
        ];

        const entries = buildUserMessageGuide(messages);
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.messageIndex, 2);
    });
});
