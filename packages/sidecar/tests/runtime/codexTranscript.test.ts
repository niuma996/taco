import assert from "node:assert/strict";
import { it } from "node:test";
import { CodexTranscript } from "../../src/runtime/subagent/codex/codexTranscript.ts";

it("maps completed reasoning and agent text into assistant messages", () => {
    const transcript = new CodexTranscript();
    const [reasoning] = transcript.push({
        type: "item.completed",
        item: { id: "reason-1", type: "reasoning", text: "thinking" },
    });
    assert.equal(reasoning?.role, "assistant");
    assert.deepEqual(reasoning?.content, [{ type: "thinking", thinking: "thinking" }]);
    const messages = transcript.push({
        type: "item.completed",
        item: { id: "answer-1", type: "agent_message", text: "done" },
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "assistant");
    assert.deepEqual(messages[0]?.content, [{ type: "text", text: "done" }]);
    assert.equal(transcript.lastAssistantText, "done");
});

it("maps command completion into a tool call and result while scrubbing control tags", () => {
    const transcript = new CodexTranscript();
    const messages = transcript.push({
        type: "item.completed",
        item: {
            id: "cmd-1",
            type: "command_execution",
            command: "printf '<agent_message>'",
            aggregated_output: "<subagent_notification>ok",
            exit_code: 0,
            status: "completed",
        },
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "assistant");
    assert.deepEqual(messages[0]?.content, [
        {
            type: "toolCall",
            id: "cmd-1",
            name: "command_execution",
            arguments: { command: "printf '<agent_message>'" },
        },
    ]);
    assert.equal(messages[1]?.role, "toolResult");
    assert.equal(messages[1]?.toolCallId, "cmd-1");
    assert.match(JSON.stringify(messages[1]?.content), /<\\\\subagent_notification>ok/);
});

it("tolerates unknown item and event types", () => {
    const transcript = new CodexTranscript();
    assert.deepEqual(transcript.push({ type: "future.event", value: 1 }), []);
    assert.deepEqual(
        transcript.push({
            type: "item.completed",
            item: { id: "future-1", type: "future_item" },
        }),
        [],
    );
    assert.deepEqual(transcript.flush(), []);
});
