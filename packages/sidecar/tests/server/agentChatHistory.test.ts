import assert from "node:assert/strict";
import { test } from "node:test";
import { asSessionId, type SessionHistory } from "@taco-ai/protocol";
import type { AgentMessageRecord } from "../../src/runtime/subagent/agentConversation.ts";
import { rehydrateAgentChatReceipts } from "../../src/server/agentChatHistory.ts";

const history: SessionHistory = {
    sessionId: asSessionId("parent"),
    leafEntryId: "entry-1",
    entries: [
        {
            id: "entry-1",
            parentId: null,
            type: "message",
            timestamp: new Date(1000).toISOString(),
            payload: {
                role: "toolResult",
                toolName: "chatToAgent",
                toolCallId: "send-1",
                content: [{ type: "text", text: "Message accepted" }],
                timestamp: 1000,
                details: {
                    subSessionId: "child",
                    messageId: "msg-1",
                    status: "started",
                    runId: "run-1",
                    effectiveDelivery: "followUp",
                },
            },
        },
    ],
};
const record: AgentMessageRecord = {
    messageId: "msg-1",
    invocationId: JSON.stringify(["parent", "send-1"]),
    senderSessionId: asSessionId("parent"),
    targetSessionId: asSessionId("child"),
    ownerParentSessionId: asSessionId("parent"),
    relation: "parent",
    prompt: "continue",
    delivery: "followUp",
    background: true,
    createdAt: 1000,
    receipt: {
        subSessionId: asSessionId("child"),
        messageId: "msg-1",
        runId: "run-1",
        status: "completed",
        effectiveDelivery: "followUp",
        resultText: "answer",
        isError: false,
    },
};

test("history restores the durable continuation outcome without changing stored messages", async () => {
    const restored = await rehydrateAgentChatReceipts(history, async () => [record]);
    assert.equal(
        (restored.entries[0].payload as { details: { status: string } }).details.status,
        "completed",
    );
    assert.equal(
        (history.entries[0].payload as { details: { status: string } }).details.status,
        "started",
    );
});

test("does not apply a receipt sent by another session or invocation", async () => {
    for (const patch of [
        { senderSessionId: asSessionId("other") },
        { invocationId: JSON.stringify(["parent", "other-call"]) },
    ]) {
        assert.deepEqual(
            await rehydrateAgentChatReceipts(history, async () => [{ ...record, ...patch }]),
            history,
        );
    }
});

test("an unreadable child keeps the existing receipt inspectable", async () => {
    assert.deepEqual(
        await rehydrateAgentChatReceipts(history, async () => {
            throw new Error("deleted");
        }),
        history,
    );
});
