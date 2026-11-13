import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEventToMessages } from "../../../src/lib/chat/applyEventToMessages";
import {
    historyToUiMessages,
    type SessionEventLike,
    type UiMessage,
} from "../../../src/lib/chat/chatUtils";

const opts = { now: 1000, suppressedThinking: false };
const provenance = { messageId: "delivery-1", senderSessionId: "sender", relation: "parent" };
const message = { role: "user", content: "continue", timestamp: 1000, agentProvenance: provenance };
const event = { type: "message_end", message } as SessionEventLike;

describe("agent message provenance", () => {
    it("preserves provenance from historical user-role delivery records", () => {
        const messages = historyToUiMessages([
            { id: "entry-1", type: "message", payload: message },
        ]);
        assert.deepEqual(messages[0], {
            id: "entry-1",
            kind: "user",
            text: "continue",
            ts: 1000,
            agentProvenance: provenance,
        });
    });

    it("preserves provenance on live deliveries and never consumes a same-text optimistic human input", () => {
        const human: UiMessage = {
            id: "optimistic-user-1",
            kind: "user",
            text: "continue",
            ts: 1000,
        };
        const messages = applyEventToMessages([human], event, opts).messages;
        assert.equal(messages.length, 2);
        assert.equal(messages[0], human);
        assert.deepEqual(messages[1], {
            id: "agent-message-delivery-1",
            kind: "user",
            text: "continue",
            ts: 1000,
            agentProvenance: provenance,
        });
    });

    it("deduplicates a live delivery against history by envelope id despite a new timestamp", () => {
        const history = historyToUiMessages([{ id: "entry-1", type: "message", payload: message }]);
        const replay = {
            type: "message_end",
            message: { ...message, timestamp: 2000 },
        } as SessionEventLike;
        assert.equal(applyEventToMessages(history, replay, opts).messages.length, 1);
    });

    it("keeps distinct agent deliveries and human inputs with the same timestamp", () => {
        const human: UiMessage = { id: "live-user-1000", kind: "user", text: "continue", ts: 1000 };
        const first = applyEventToMessages([human], event, opts).messages;
        const next = {
            type: "message_end",
            message: { ...message, agentProvenance: { ...provenance, messageId: "delivery-2" } },
        } as SessionEventLike;
        const second = applyEventToMessages(first, next, opts).messages;
        assert.equal(second.length, 3);
        assert.equal(new Set(second.map((m) => m.id)).size, 3);
    });
});
