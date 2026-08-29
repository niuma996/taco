/**
 * applyEventToMessages tests — covers streaming accumulation, tool upsert, suppressed thinking, etc.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:events
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { applyEventToMessages } from "../../../src/lib/chat/applyEventToMessages";
import type { SessionEventLike, UiMessage } from "../../../src/lib/chat/chatUtils";

/** cast helper — assistantMessageEvent is a protocol-internal field (see applyEventToMessages.ts top comment) */
function asEv(p: object): SessionEventLike {
    return p as unknown as SessionEventLike;
}

const NOW = 1_700_000_000_000;
const baseOpts = { suppressedThinking: false, now: NOW };

describe("applyEventToMessages — message lifecycle", () => {
    it("message_start(assistant) → 新建 live-asst-<ts> 空 bubble", () => {
        const ev = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const { messages, clearPending } = applyEventToMessages([], ev, baseOpts);
        assert.equal(clearPending, false);
        assert.equal(messages.length, 1);
        const m = messages[0];
        assert.equal(m?.kind, "assistant");
        assert.equal(m?.id, "live-asst-t1");
        assert.equal(m?.text, "");
    });

    it("同 message_start 来第二次不重复建 bubble", () => {
        const ev = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const first = applyEventToMessages([], ev, baseOpts).messages;
        const second = applyEventToMessages(first, ev, baseOpts).messages;
        assert.equal(second.length, 1);
    });

    it("message_update.text_delta → 累积 text", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;

        const update1 = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "hello " },
        });
        const after1 = applyEventToMessages(started, update1, baseOpts).messages;
        const update2 = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "world" },
        });
        const after2 = applyEventToMessages(after1, update2, baseOpts).messages;

        const asst = after2[0];
        assert.equal(asst?.kind, "assistant");
        assert.equal((asst as Extract<UiMessage, { kind: "assistant" }>).text, "hello world");
    });

    it("message_update.text_delta 没匹配 bubble → no-op(返回入参引用)", () => {
        const update = asEv({
            type: "message_update",
            message: { timestamp: "missing", role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "x" },
        });
        const { messages } = applyEventToMessages([], update, baseOpts);
        assert.equal(messages.length, 0);
    });
});

describe("applyEventToMessages — thinking suppressed", () => {
    it("suppressedThinking=true → thinking_delta 不累积", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const thinking = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "secret" },
        });
        const optsSuppressed = { suppressedThinking: true, now: NOW };
        const { messages } = applyEventToMessages(started, thinking, optsSuppressed);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.thinking.length, 0);
    });

    it("suppressedThinking=false → thinking_delta 累积", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        // Create the placeholder first (otherwise thinking_delta finds no block)
        const thinkingStart = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
        });
        const afterStart = applyEventToMessages(started, thinkingStart, baseOpts).messages;
        const thinking = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thought" },
        });
        const { messages } = applyEventToMessages(afterStart, thinking, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.thinking.length, 1);
        assert.equal(asst.thinking[0]?.thinking, "thought");
    });
});

describe("applyEventToMessages — message_end", () => {
    it("message_end(assistant,已有 bubble) → 覆盖 text + 合并 redacted", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        // Push a thinking_start to create the placeholder first (otherwise thinking[0] is undefined)
        const thinkingStart = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
        });
        const afterThinking = applyEventToMessages(started, thinkingStart, baseOpts).messages;
        const update = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "partial" },
        });
        const after = applyEventToMessages(afterThinking, update, baseOpts).messages;

        const end = asEv({
            type: "message_end",
            message: {
                timestamp: "t1",
                role: "assistant",
                content: [
                    { type: "thinking", redacted: true },
                    { type: "text", text: "final answer" },
                ],
            },
        });
        const { messages } = applyEventToMessages(after, end, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.text, "final answer");
        assert.equal(asst.thinking[0]?.redacted, true);
        assert.equal(asst.thinking[0]?.thinking, "");
    });

    it("message_end(user) → 插入 user row", () => {
        const end = asEv({
            type: "message_end",
            message: { timestamp: "u1", role: "user", content: "hi" },
        });
        const { messages } = applyEventToMessages([], end, baseOpts);
        assert.equal(messages.length, 1);
        const m = messages[0];
        assert.equal(m?.kind, "user");
        assert.equal(m?.id, "live-user-u1");
    });
});

describe("applyEventToMessages — tool execution", () => {
    it("tool_execution_start → upsert 到 last assistant.tools", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;

        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "Read",
            args: { path: "/foo" },
        });
        const { messages } = applyEventToMessages(started, toolStart, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.tools.length, 1);
        assert.equal(asst.tools[0]?.id, "tc1");
        assert.equal(asst.tools[0]?.status, "running");
    });

    it("tool_execution_update → 写 partialResult 字符串", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "Read",
        });
        const after1 = applyEventToMessages(started, toolStart, baseOpts).messages;
        const update = asEv({
            type: "tool_execution_update",
            toolCallId: "tc1",
            partialResult: "partial data",
        });
        const { messages } = applyEventToMessages(after1, update, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.tools[0]?.resultText, "partial data");
    });

    it("tool_execution_end(isError=false) → status=ok + resultText", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "Read",
        });
        const after1 = applyEventToMessages(started, toolStart, baseOpts).messages;
        const end = asEv({
            type: "tool_execution_end",
            toolCallId: "tc1",
            isError: false,
            result: { content: [{ type: "text", text: "file contents" }] },
        });
        const { messages } = applyEventToMessages(after1, end, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.tools[0]?.status, "ok");
        assert.ok(asst.tools[0]?.resultText?.includes("file contents"));
    });

    it("tool_execution_end(isError=true) → status=error", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "Read",
        });
        const after1 = applyEventToMessages(started, toolStart, baseOpts).messages;
        const end = asEv({
            type: "tool_execution_end",
            toolCallId: "tc1",
            isError: true,
        });
        const { messages } = applyEventToMessages(after1, end, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(asst.tools[0]?.status, "error");
    });

    it("无 assistant 容器 → tool_execution_start 插入独立 tool row", () => {
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "Read",
        });
        const { messages } = applyEventToMessages([], toolStart, baseOpts);
        assert.equal(messages.length, 1);
        assert.equal(messages[0]?.kind, "tool");
    });
});

describe("applyEventToMessages — 不 mutate 入参", () => {
    it("message_update 累积 text_delta 不改原始 messages 数组中的 assistant 对象", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const originalAssistant = started[0] as Extract<UiMessage, { kind: "assistant" }>;
        const originalTextRef = originalAssistant;

        const update = asEv({
            type: "message_update",
            message: { timestamp: "t1", role: "assistant" },
            assistantMessageEvent: { type: "text_delta", delta: "hello" },
        });
        const { messages } = applyEventToMessages(started, update, baseOpts);
        const afterAssistant = messages[0] as Extract<UiMessage, { kind: "assistant" }>;

        assert.equal(afterAssistant.text, "hello");
        // Original messages[0].text must still be empty (not mutated)
        assert.equal(originalTextRef.text, "");
        // Returned bubble must be a new object reference
        assert.notEqual(afterAssistant, originalAssistant);
    });

    it("tool_execution_end 写 status 不改原始 assistant.tools[i].status", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "Read",
        });
        const after1 = applyEventToMessages(started, toolStart, baseOpts).messages;
        const originalTool = (after1[0] as Extract<UiMessage, { kind: "assistant" }>).tools[0];

        const end = asEv({
            type: "tool_execution_end",
            toolCallId: "tc1",
            isError: false,
            result: { content: [{ type: "text", text: "ok" }] },
        });
        const { messages } = applyEventToMessages(after1, end, baseOpts);
        const afterAssistant = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        assert.equal(afterAssistant.tools[0]?.status, "ok");
        // Original tool.status must still be "running" (not mutated)
        assert.equal(originalTool?.status, "running");
    });
});

describe("applyEventToMessages — tool_execution_end details 合并", () => {
    /**
     * Second tool_execution_end for planExit / askUser drops fields:
     *   - askUser: drops questions (result details only include answers)
     *   - planExit: drops questions + planContent (result details only include approved;
     *     planContent is deliberately "" because planExit's second state skips readFileSync)
     * applyEventToMessages must merge from the previous frame's tool card, or the UI regresses.
     */
    function setupAssistantWithPlanExitStart(): UiMessage[] {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc-plan",
            toolName: "planExit",
        });
        return applyEventToMessages(started, toolStart, baseOpts).messages;
    }

    it("planExit 首次 tool_execution_end 写入 questions + planContent", () => {
        const started = setupAssistantWithPlanExitStart();
        const end = asEv({
            type: "tool_execution_end",
            toolCallId: "tc-plan",
            toolName: "planExit",
            isError: false,
            result: {
                content: [{ type: "text", text: "**Plan: ...**" }],
                details: {
                    questions: [
                        {
                            question: "Approve this plan?",
                            header: "planExit",
                            options: [{ label: "Approve" }, { label: "Reject" }],
                            multiSelect: false,
                        },
                    ],
                    planContent: "# Plan\n\nLong body...",
                    waiting: true,
                },
            },
        });
        const { messages } = applyEventToMessages(started, end, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        const tool = asst.tools[0];
        assert.ok(tool);
        const details = tool.details as { questions?: unknown; planContent?: string };
        assert.ok(details.questions, "first call must carry questions");
        assert.equal(details.planContent, "# Plan\n\nLong body...");
    });

    it("planExit 二次 tool_execution_end 合并 questions + planContent from prev", () => {
        const started = setupAssistantWithPlanExitStart();
        // First call
        const firstEnd = asEv({
            type: "tool_execution_end",
            toolCallId: "tc-plan",
            toolName: "planExit",
            isError: false,
            result: {
                content: [{ type: "text", text: "preview" }],
                details: {
                    questions: [{ question: "Approve this plan?" }],
                    planContent: "# Original Plan",
                    waiting: true,
                },
            },
        });
        const afterFirst = applyEventToMessages(started, firstEnd, baseOpts).messages;

        // Second call (user approved) — planContent deliberately "" means no re-read
        const secondEnd = asEv({
            type: "tool_execution_end",
            toolCallId: "tc-plan",
            toolName: "planExit",
            isError: false,
            result: {
                content: [{ type: "text", text: "Plan approved." }],
                details: {
                    approved: true,
                    planContent: "",
                },
            },
        });
        const { messages } = applyEventToMessages(afterFirst, secondEnd, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        const details = asst.tools[0]?.details as {
            questions?: unknown;
            planContent?: string;
            approved?: boolean;
        };
        // Second call must retain: questions (from prev) + planContent (from prev, because new is "")
        assert.ok(details.questions, "questions must be merged from prev");
        assert.equal(
            details.planContent,
            "# Original Plan",
            "planContent must be merged from prev",
        );
        assert.equal(details.approved, true, "approved from new must win");
    });

    it("askUser 二次 tool_execution_end 合并 questions from prev", () => {
        const start = asEv({
            type: "message_start",
            message: { timestamp: "t1", role: "assistant" },
        });
        const started = applyEventToMessages([], start, baseOpts).messages;
        const toolStart = asEv({
            type: "tool_execution_start",
            toolCallId: "tc-ask",
            toolName: "askUser",
        });
        const withStart = applyEventToMessages(started, toolStart, baseOpts).messages;

        // First call
        const firstEnd = asEv({
            type: "tool_execution_end",
            toolCallId: "tc-ask",
            isError: false,
            result: {
                content: [{ type: "text", text: "?" }],
                details: {
                    questions: [{ question: "Q1?" }],
                    waiting: true,
                },
            },
        });
        const afterFirst = applyEventToMessages(withStart, firstEnd, baseOpts).messages;

        // Second call (user answered)
        const secondEnd = asEv({
            type: "tool_execution_end",
            toolCallId: "tc-ask",
            toolName: "askUser",
            isError: false,
            result: {
                content: [{ type: "text", text: "answered" }],
                details: {
                    answers: { "Q1?": "Yes" },
                },
            },
        });
        const { messages } = applyEventToMessages(afterFirst, secondEnd, baseOpts);
        const asst = messages[0] as Extract<UiMessage, { kind: "assistant" }>;
        const details = asst.tools[0]?.details as { questions?: unknown; answers?: unknown };
        assert.ok(details.questions, "askUser questions must be merged from prev");
        assert.deepEqual(details.answers, { "Q1?": "Yes" });
    });
});

describe("applyEventToMessages — pending 翻转", () => {
    it("agent_end → clearPending=true", () => {
        const { clearPending } = applyEventToMessages([], { type: "agent_end" }, baseOpts);
        assert.equal(clearPending, true);
    });

    it("turn_end → clearPending=true", () => {
        const { clearPending } = applyEventToMessages([], { type: "turn_end" }, baseOpts);
        assert.equal(clearPending, true);
    });

    it("其他事件 → clearPending=false", () => {
        const { clearPending } = applyEventToMessages(
            [],
            { type: "message_start", message: { timestamp: "t1", role: "assistant" } },
            baseOpts,
        );
        assert.equal(clearPending, false);
    });
});
