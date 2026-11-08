import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyEventToMessages } from "../../../src/lib/chat/applyEventToMessages";
import type { SessionEventLike, UiMessage } from "../../../src/lib/chat/chatUtils";
import { transcriptBytes } from "../../../src/lib/chat/sessionState";
import { attachAskUserAnswers } from "../../../src/lib/chat/workspaceMessagePatches";

function user(text: string, id = "user"): UiMessage {
    return { id, kind: "user", text, ts: 1 };
}

function assistant(): Extract<UiMessage, { kind: "assistant" }> {
    return {
        id: "live-asst-2",
        kind: "assistant",
        ts: 2,
        text: '你好 🌮\n"quoted"\\\t\u0000\ud800',
        thinking: [{ thinking: "café e\u0301", startedAt: 2 }],
        tools: [
            {
                id: "tool",
                name: "askUser",
                status: "running",
                args: { question: "继续？", omitted: undefined },
                resultText: '输出\n"value"\\path',
                details: { nested: [null, true, 3.5, "😀"], waiting: true },
            },
        ],
    };
}

function exactBytes(messages: UiMessage[]): number {
    return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function deepFreeze(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
}

test("transcriptBytes matches JSON UTF-8 bytes including punctuation and nested tool output", () => {
    const messages: UiMessage[] = [
        user("ASCII"),
        assistant(),
        { id: "system", kind: "system", text: "\r\b\f\udfff", ts: 3 },
        { id: "orphan", kind: "tool", text: "工具输出", ts: 4 },
    ];
    assert.equal(transcriptBytes([]), 2);
    for (let length = 1; length <= messages.length; length++) {
        const prefix = messages.slice(0, length);
        assert.equal(transcriptBytes(prefix), exactBytes(prefix));
    }
    const first = messages[0];
    const second = messages[1];
    assert.ok(first && second);
    const repeated = [first, first, second];
    assert.equal(transcriptBytes(repeated), exactBytes(repeated));
});

test("unchanged message objects reuse serialization and encoding across new arrays", (t) => {
    const messages = [user("large history ".repeat(10_000)), assistant()];
    const expected = exactBytes(messages);
    const stringify = t.mock.method(JSON, "stringify");
    const encode = t.mock.method(TextEncoder.prototype, "encode");
    assert.equal(transcriptBytes(messages), expected);
    const serializations = stringify.mock.callCount();
    const encodings = encode.mock.callCount();

    for (let i = 0; i < 10; i++) assert.equal(transcriptBytes([...messages]), expected);

    assert.equal(stringify.mock.callCount(), serializations);
    assert.equal(encode.mock.callCount(), encodings);
});

test("streaming deltas serialize only each changed tail and preserve exact totals", (t) => {
    const history = Array.from({ length: 100 }, (_, i) => user("history".repeat(1_000), `${i}`));
    let messages: UiMessage[] = [...history, assistant()];
    transcriptBytes(messages);
    const originalStringify = JSON.stringify;
    const stringify = t.mock.method(JSON, "stringify");
    const encode = t.mock.method(TextEncoder.prototype, "encode");
    for (let i = 0; i < 20; i++) {
        const before = messages;
        deepFreeze(before);
        messages = applyEventToMessages(
            before,
            {
                type: "message_update",
                message: { role: "assistant", timestamp: 2 },
                assistantMessageEvent: { type: "text_delta", delta: '🌮\n"' },
            },
            { now: 3, suppressedThinking: false },
        ).messages;
        assert.notEqual(messages.at(-1), before.at(-1));
        assert.equal(messages[0], before[0]);
        assert.equal(transcriptBytes(messages), Buffer.byteLength(originalStringify(messages)));
    }
    assert.equal(stringify.mock.callCount(), 20);
    assert.ok(stringify.mock.calls.every((call) => !Array.isArray(call.arguments[0])));
    assert.equal(encode.mock.callCount(), 20);
});

test("thinking, tool updates, completion and answer patches replace measured messages", () => {
    const events: SessionEventLike[] = [
        {
            type: "message_update",
            message: { role: "assistant", timestamp: 2 },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "思考😀" },
        },
        {
            type: "tool_update",
            toolCallId: "tool",
            partialResult: {
                content: [{ type: "text", text: "更多输出" }],
                details: { waiting: true },
            },
        },
        {
            type: "tool_end",
            toolCallId: "tool",
            toolName: "askUser",
            result: { content: [{ type: "text", text: "完成" }], details: { waiting: true } },
        },
        {
            type: "message_end",
            message: {
                role: "assistant",
                timestamp: 2,
                content: [{ type: "text", text: "最终回复" }],
            },
        },
    ];
    let messages: UiMessage[] = [user("history"), assistant()];
    for (const event of events) {
        const before = messages;
        const previousBytes = transcriptBytes(before);
        const snapshot = JSON.stringify(before);
        deepFreeze(before);
        messages = applyEventToMessages(before, event, {
            now: 3,
            suppressedThinking: false,
        }).messages;
        assert.notEqual(messages[1], before[1]);
        assert.equal(messages[0], before[0]);
        assert.equal(JSON.stringify(before), snapshot);
        assert.equal(transcriptBytes(before), previousBytes);
        assert.equal(transcriptBytes(messages), exactBytes(messages));
    }
    deepFreeze(messages);
    const answered = attachAskUserAnswers(messages, "tool", { answer: "是 ✅" });
    assert.notEqual(answered[1], messages[1]);
    assert.equal(transcriptBytes(answered), exactBytes(answered));
});

test("replacement objects with the same id are remeasured, including shorter tails", () => {
    const first = user("😀".repeat(1_000));
    const shorter = { ...first, text: "x" };
    const appended = user('"\\\n', "new");
    for (const messages of [[first], [shorter], [shorter, appended], [appended], []]) {
        assert.equal(transcriptBytes(messages), exactBytes(messages));
    }
});
