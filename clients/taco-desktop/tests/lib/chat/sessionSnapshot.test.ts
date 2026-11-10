import assert from "node:assert/strict";
import { test } from "node:test";
import { asSessionId, type SessionSnapshot } from "@taco-ai/protocol";
import { applyEventToMessages } from "../../../src/lib/chat/applyEventToMessages";
import { snapshotToUiMessages } from "../../../src/lib/chat/sessionSnapshot";

function snapshot(): SessionSnapshot {
    return {
        sessionId: asSessionId("a"),
        sessionKind: "main",
        snapshotSeq: 20,
        history: { sessionId: asSessionId("a"), leafEntryId: null, entries: [] },
        runtime: {
            operation: { id: "run", kind: "run", status: "running", startedAt: 10 },
            partialMessage: {
                role: "assistant",
                timestamp: 12,
                content: [{ type: "text", text: "hello" }],
            },
            tools: [],
            queues: [],
            pendingCommandPermissions: [],
            pendingAskUserToolCallIds: [],
            inFlightAgentToolCallIds: [],
            settledBackgroundSubSessionIds: [],
        },
    } as SessionSnapshot;
}

test("restores the partial assistant with a stable live identity and continues streaming", () => {
    const messages = snapshotToUiMessages(snapshot());
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.id, "live-asst-12");
    assert.equal(messages[0]?.text, "hello");
    const continued = applyEventToMessages(
        messages,
        {
            type: "message_update",
            message: { role: "assistant", timestamp: 12 },
            assistantMessageEvent: { type: "text_delta", delta: " world", contentIndex: 0 },
        },
        { now: 15, suppressedThinking: false },
    ).messages;
    assert.equal(continued[0]?.text, "hello world");
});

test("restored thinking retains its original content index when text precedes it", () => {
    const value = snapshot();
    assert.ok(value.runtime);
    value.runtime.partialMessage = {
        role: "assistant",
        timestamp: 12,
        content: [
            { type: "text", text: "hello" },
            { type: "thinking", thinking: "reason" },
        ],
    };
    const continued = applyEventToMessages(
        snapshotToUiMessages(value),
        {
            type: "message_update",
            message: { role: "assistant", timestamp: 12 },
            assistantMessageEvent: { type: "thinking_delta", delta: "ing", contentIndex: 1 },
        },
        { now: 15, suppressedThinking: false },
    ).messages;
    const message = continued[0];
    if (message?.kind !== "assistant") assert.fail("expected assistant");
    assert.equal(message.thinking[1]?.thinking, "reasoning");
});

test("overlays authoritative tool progress on its original history bubble", () => {
    const value = snapshot();
    assert.ok(value.runtime);
    value.history.entries = [
        {
            id: "persisted",
            type: "message",
            parentId: null,
            timestamp: "2026-01-01",
            payload: {
                role: "assistant",
                timestamp: 8,
                content: [
                    {
                        type: "toolCall",
                        id: "tool",
                        name: "shell",
                        arguments: { command: "sleep" },
                    },
                ],
            },
        },
    ];
    value.runtime = {
        ...value.runtime,
        partialMessage: undefined,
        tools: [
            {
                toolCallId: "tool",
                toolName: "shell",
                args: { command: "sleep" },
                status: "running",
                result: { content: [{ type: "text", text: "progress" }], details: { progress: 2 } },
            },
        ],
    };
    const messages = snapshotToUiMessages(value);
    assert.equal(messages.length, 1);
    const assistant = messages[0];
    assert.equal(assistant?.kind, "assistant");
    if (assistant?.kind !== "assistant") assert.fail("expected assistant");
    assert.deepEqual(
        assistant.tools.map((t) => [t.id, t.status, t.resultText]),
        [["tool", "running", "progress"]],
    );
    assert.deepEqual(assistant.tools[0]?.details, { progress: 2 });
});

test("does not duplicate a partial assistant already present in the captured transcript", () => {
    const value = snapshot();
    value.history.entries = [
        {
            id: "persisted",
            type: "message",
            parentId: null,
            timestamp: "2026-01-01",
            payload: value.runtime?.partialMessage,
        },
    ];
    assert.equal(snapshotToUiMessages(value).length, 1);
});

test("keeps tool calls already present in the partial assistant before tool_start arrives", () => {
    const value = snapshot();
    assert.ok(value.runtime);
    value.runtime.partialMessage = {
        role: "assistant",
        timestamp: 12,
        content: [
            { type: "text", text: "calling" },
            { type: "toolCall", id: "new-tool", name: "shell", arguments: { command: "pwd" } },
        ],
    };
    const message = snapshotToUiMessages(value)[0];
    assert.equal(message?.kind, "assistant");
    if (message?.kind !== "assistant") assert.fail("expected assistant");
    assert.equal(message.tools[0]?.id, "new-tool");
});
