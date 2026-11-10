import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiMessage } from "../../../src/lib/chat/chatUtils";
import {
    createConversationWatermark,
    observeConversationMessages,
} from "../../../src/lib/chat/conversationActivity";

describe("bounded conversation read watermark", () => {
    it("retains at most 32 fingerprints while remembering the newest observed timestamp", () => {
        const watermark = createConversationWatermark();
        const messages: UiMessage[] = Array.from({ length: 5000 }, (_, i) => ({
            id: `user-${i}`,
            kind: "user",
            text: `message ${i}`,
            ts: i + 200,
        }));
        observeConversationMessages(watermark, messages, true, 100);
        assert.ok(watermark.fingerprints.size <= 32);
        assert.equal(watermark.latestTimestamp, 5199);
        const replay: UiMessage[] = [
            { id: "replayed-old", kind: "user", text: "message 0", ts: 200 },
        ];
        assert.equal(observeConversationMessages(watermark, replay, true, 100), false);
        assert.equal(watermark.latestTimestamp, 5199);
        assert.equal(
            observeConversationMessages(
                watermark,
                [...messages, { id: "next", kind: "user", text: "new remote message", ts: 6000 }],
                true,
                100,
            ),
            true,
        );
        assert.ok(watermark.fingerprints.size <= 32);
    });
});

describe("replayed message identity", () => {
    it("does not turn timestamp collisions into unread on an identical replay", () => {
        const watermark = createConversationWatermark();
        const messages: UiMessage[] = [
            { id: "first-live", kind: "user", text: "first", ts: 200 },
            { id: "second-live", kind: "user", text: "second", ts: 200 },
        ];
        observeConversationMessages(watermark, messages, false, 100);
        const replay = messages.map((message, i) => ({ ...message, id: `persisted-${i}` }));
        assert.equal(observeConversationMessages(watermark, replay, true, 100), false);
    });
});
