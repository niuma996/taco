/**
 * normalizeMessageUpdate — the streamed sub-event must reach clients under the
 * name they read.
 *
 * pi 0.85 declares the field as `assistantMessageEvent` but emits it as
 * `event`. Clients read the declared name, so an un-normalized frame drops
 * every streaming delta and the reply appears all at once. Type-checking
 * cannot catch the mismatch (the shipped .d.ts disagrees with the shipped JS),
 * so the guard has to be a runtime assertion on the real event shape.
 *
 * The end-to-end shape is pinned by streaming a faux provider through a real
 * harness in `attachedSession.streaming.test.ts`; this file covers the pure
 * transform, including the pass-through cases.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normalizeMessageUpdate } from "../../src/server/push.ts";

describe("normalizeMessageUpdate", () => {
    it("copies the runtime `event` field onto the declared `assistantMessageEvent`", () => {
        const sub = { type: "text_delta", contentIndex: 0, delta: "hi" };
        const normalized = normalizeMessageUpdate({
            type: "message_update",
            message: { role: "assistant", timestamp: 1 },
            event: sub,
        }) as { assistantMessageEvent?: unknown; event?: unknown };

        assert.deepEqual(
            normalized.assistantMessageEvent,
            sub,
            "clients read assistantMessageEvent; without it every delta is dropped",
        );
        // Both names ship so the frame keeps working whichever one a client
        // reads, and a pi release that honours its own declaration is a no-op.
        assert.deepEqual(normalized.event, sub, "the runtime field is preserved");
    });

    it("leaves an already-conforming event untouched", () => {
        const sub = { type: "text_delta", delta: "hi" };
        const input = {
            type: "message_update",
            message: { role: "assistant" },
            assistantMessageEvent: sub,
        };
        assert.equal(
            normalizeMessageUpdate(input),
            input,
            "same reference — no needless copy when pi honours its declaration",
        );
    });

    it("passes through other event types and non-objects", () => {
        for (const input of [
            { type: "message_end", message: { role: "assistant" } },
            { type: "tool_start", toolCallId: "tc-1" },
            undefined,
            null,
            "not-an-object",
        ]) {
            assert.equal(normalizeMessageUpdate(input), input);
        }
    });

    it("does not invent the field when the runtime omits both names", () => {
        const input = { type: "message_update", message: { role: "assistant" } };
        assert.equal(normalizeMessageUpdate(input), input);
        assert.equal(
            (input as { assistantMessageEvent?: unknown }).assistantMessageEvent,
            undefined,
        );
    });
});
