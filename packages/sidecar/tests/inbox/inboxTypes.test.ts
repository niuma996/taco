import assert from "node:assert/strict";
import { it } from "node:test";
import { inboxBatchId, inboxReceiptId, inboxSourceKey } from "../../src/inbox/inboxTypes.ts";

it("includes binding and conversation in the stable receipt identity", () => {
    const a = inboxSourceKey({
        bindingId: "a",
        channelId: "c",
        peerId: "p",
        chatId: "x",
        platformMessageId: "m",
    });
    const b = inboxSourceKey({
        bindingId: "b",
        channelId: "c",
        peerId: "p",
        chatId: "x",
        platformMessageId: "m",
    });
    assert.notEqual(a, b);
    assert.match(inboxReceiptId(a), /^i-[a-f0-9]{32}$/);
});

it("makes batch identity depend on frozen ordered members", () => {
    assert.notEqual(inboxBatchId("im://a", ["r1", "r2"]), inboxBatchId("im://a", ["r2", "r1"]));
    assert.equal(inboxBatchId("im://a", ["r1"]), inboxBatchId("im://a", ["r1"]));
});
