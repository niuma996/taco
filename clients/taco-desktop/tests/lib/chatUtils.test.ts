/**
 * chatUtils pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:utils
 *
 * No new dependencies. Only covers pure functions in chatUtils.ts
 * (historyToUiMessages id-join + summarizeToolArgs). UI rendering is out of scope.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    extractAssistantTextAndThinking,
    findPendingAskUserIds,
    type HistoryEntryLike,
    historyToUiMessages,
    type MessageLike,
    summarizeToolArgs,
    type UiThinkingBlock,
} from "../../src/lib/chatUtils";

describe("historyToUiMessages — id join", () => {
    it("把 AssistantMessage 的 text 与 toolCall 拆开", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "user",
                    content: "Read foo.ts",
                    timestamp: 1,
                },
            },
            {
                id: "e2",
                type: "message",
                timestamp: "2026-01-01T00:00:01Z",
                payload: {
                    role: "assistant",
                    content: [
                        { type: "text", text: "好的,我读一下。" },
                        {
                            type: "toolCall",
                            id: "tc-1",
                            name: "read",
                            arguments: { path: "/tmp/foo.ts" },
                        },
                    ],
                    timestamp: 2,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        assert.equal(ui.length, 2);
        assert.equal(ui[0].kind, "user");
        assert.equal(ui[1].kind, "assistant");
        if (ui[1].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[1].text, "好的,我读一下。");
        assert.equal(ui[1].tools.length, 1);
        assert.equal(ui[1].tools[0].id, "tc-1");
        // toolCall starts as "running"; tool calls without a matching toolResult at the end of
        // replay are converged to "error" by expireUnresolvedToolCalls — see the
        // "orphaned toolCall without toolResult" test case below.
        assert.equal(ui[1].tools[0].status, "error");
        assert.equal(ui[1].tools[0].resultText, undefined);
    });

    it("toolResult entry 通过 toolCallId 命中上一条 assistant 中的 tool,改为 ok + resultText", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "tc-1",
                            name: "read",
                            arguments: { path: "/tmp/foo.ts" },
                        },
                    ],
                    timestamp: 1,
                },
            },
            {
                id: "e2",
                type: "message",
                timestamp: "2026-01-01T00:00:01Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "tc-1",
                    toolName: "read",
                    content: [{ type: "text", text: "file contents here" }],
                    isError: false,
                    timestamp: 2,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        assert.equal(ui.length, 1);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[0].tools.length, 1);
        assert.equal(ui[0].tools[0].id, "tc-1");
        assert.equal(ui[0].tools[0].status, "ok");
        assert.equal(ui[0].tools[0].resultText, "file contents here");
    });

    it("error 结果会把 status 设为 error", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "tc-1",
                            name: "bash",
                            arguments: { command: "exit 1" },
                        },
                    ],
                    timestamp: 1,
                },
            },
            {
                id: "e2",
                type: "message",
                timestamp: "2026-01-01T00:00:01Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "tc-1",
                    toolName: "bash",
                    content: [{ type: "text", text: "command failed" }],
                    isError: true,
                    timestamp: 2,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[0].tools[0].status, "error");
    });

    it("orphan toolResult(找不到对应 toolCall)退化为独立 tool row", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "orphan",
                    toolName: "read",
                    content: [{ type: "text", text: "x" }],
                    isError: false,
                    timestamp: 1,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        assert.equal(ui.length, 1);
        assert.equal(ui[0].kind, "tool");
    });

    it("同一 entry id 出现两次会被去重", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "dup",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: { role: "user", content: "hi", timestamp: 1 },
            },
            {
                id: "dup",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: { role: "user", content: "hi again", timestamp: 2 },
            },
        ];
        const ui = historyToUiMessages(entries);
        assert.equal(ui.length, 1);
    });
});

describe("historyToUiMessages — toolResult details recovery", () => {
    // askUser terminates for the first time with toolResult persisting details.questions/waiting.
    // On replay the details must be copied to the tool; otherwise askUser renders an empty card.
    const askUserEntries: HistoryEntryLike[] = [
        {
            id: "e1",
            type: "message",
            timestamp: "2026-01-01T00:00:00Z",
            payload: {
                role: "assistant",
                content: [
                    { type: "text", text: "讲个冷笑话" },
                    {
                        type: "toolCall",
                        id: "call_1",
                        name: "askUser",
                        arguments: { questions: [{ question: "好笑吗?", options: [] }] },
                    },
                ],
                timestamp: 1,
            },
        },
        {
            id: "e2",
            type: "message",
            timestamp: "2026-01-01T00:00:01Z",
            payload: {
                role: "toolResult",
                toolCallId: "call_1",
                toolName: "askUser",
                content: [{ type: "text", text: "Please answer the following questions" }],
                isError: false,
                details: {
                    questions: [{ question: "好笑吗?", header: "评估", options: [] }],
                    waiting: true,
                },
                timestamp: 2,
            },
        },
    ];

    it("toolResult 的 details 被拷到命中的 tool 上", () => {
        const ui = historyToUiMessages(askUserEntries);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        const tool = ui[0].tools[0];
        assert.equal(tool.status, "ok");
        const details = tool.details as { questions?: unknown[]; waiting?: boolean } | undefined;
        assert.equal(details?.waiting, true);
        assert.equal(details?.questions?.length, 1);
    });

    it("toolResult 无 details 时不写 tool.details(保持 undefined)", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: {} }],
                    timestamp: 1,
                },
            },
            {
                id: "e2",
                type: "message",
                timestamp: "2026-01-01T00:00:01Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "tc-1",
                    toolName: "read",
                    content: [{ type: "text", text: "x" }],
                    isError: false,
                    timestamp: 2,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[0].tools[0].details, undefined);
    });
});

describe("findPendingAskUserIds", () => {
    it("最后一条 assistant 的 askUser tool 且 details.waiting===true → 返回其 id", () => {
        const ui = historyToUiMessages([
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [{ type: "toolCall", id: "call_1", name: "askUser", arguments: {} }],
                    timestamp: 1,
                },
            },
            {
                id: "e2",
                type: "message",
                timestamp: "2026-01-01T00:00:01Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "call_1",
                    toolName: "askUser",
                    content: [{ type: "text", text: "..." }],
                    isError: false,
                    details: { questions: [{ question: "q", options: [] }], waiting: true },
                    timestamp: 2,
                },
            },
        ]);
        assert.deepEqual(findPendingAskUserIds(ui), ["call_1"]);
    });

    it("已答过的会话(askUser 后又有新 assistant 消息)→ 返回空", () => {
        const ui = historyToUiMessages([
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [{ type: "toolCall", id: "call_1", name: "askUser", arguments: {} }],
                    timestamp: 1,
                },
            },
            {
                id: "e2",
                type: "message",
                timestamp: "2026-01-01T00:00:01Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "call_1",
                    toolName: "askUser",
                    content: [{ type: "text", text: "..." }],
                    isError: false,
                    details: { questions: [], waiting: true },
                    timestamp: 2,
                },
            },
            {
                id: "e3",
                type: "message",
                timestamp: "2026-01-01T00:00:02Z",
                payload: {
                    role: "assistant",
                    content: [{ type: "text", text: "收到,继续" }],
                    timestamp: 3,
                },
            },
        ]);
        assert.deepEqual(findPendingAskUserIds(ui), []);
    });

    it("最后一条是 user 消息 → 返回空", () => {
        const ui = historyToUiMessages([
            {
                id: "u1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: { role: "user", content: "hi", timestamp: 1 },
            },
        ]);
        assert.deepEqual(findPendingAskUserIds(ui), []);
    });

    it("空消息列表 → 返回空", () => {
        assert.deepEqual(findPendingAskUserIds([]), []);
    });
});

describe("summarizeToolArgs", () => {
    it("path 类字段用 shortPath", () => {
        const s = summarizeToolArgs("read", { path: "/Users/me/projects/foo/bar.ts" });
        assert.ok(s.length > 0);
        assert.ok(s.startsWith("…"));
    });
    it("command 字段原文显示(>80 字符截断)", () => {
        const cmd = "x".repeat(120);
        const s = summarizeToolArgs("bash", { command: cmd });
        assert.ok(s.endsWith("…"));
        assert.equal(s.length, 81);
    });
    it("无匹配字段时 JSON.stringify 截断", () => {
        const s = summarizeToolArgs("foo", { weird: "thing" });
        assert.ok(s.includes("weird"));
    });
    it("截断落在 token 边界(askUser 长入参不切在 label 中间)", () => {
        const questions = [
            {
                question: "你想深入提示词注入的哪个方向?",
                header: "方向选择",
                options: [{ label: "扩展贡献者机制", description: "git-context 扩展如何被激活" }],
            },
        ];
        const s = summarizeToolArgs("askUser", { questions });
        assert.ok(s.endsWith("…"));
        // Truncation boundary must land on a complete token — not mid-value within `"label":…`
        const body = s.slice(0, -1);
        assert.ok(
            /[,:[{]$/.test(body),
            `truncation should land on JSON boundary, got: …${body.slice(-12)}`,
        );
    });
    it("args 不是对象时返回空", () => {
        assert.equal(summarizeToolArgs("x", null), "");
        assert.equal(summarizeToolArgs("x", "raw"), "");
    });
    it("截断点找不到合法边界时回退到 80 字符硬截断", () => {
        // Single field, no ,:{[ boundary; JSON.stringify lands at exactly ≥80 with no punctuation before 80
        const s = summarizeToolArgs("foo", { blob: "x".repeat(120) });
        assert.ok(s.endsWith("…"));
        // Must not produce an empty string head (regression: lastIndexOf returning -1 caused slice(0,0))
        assert.ok(s.length > 1);
    });
});

describe("historyToUiMessages — thinking blocks", () => {
    it("从 AssistantMessage.content 提取 thinking 块,redacted 标记保留", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "让我想想...", redacted: false },
                        { type: "text", text: "答案如下。" },
                    ],
                    timestamp: 1,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        assert.equal(ui.length, 1);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[0].text, "答案如下。");
        assert.equal(ui[0].thinking.length, 1);
        const block = ui[0].thinking[0] as UiThinkingBlock;
        assert.equal(block.thinking, "让我想想...");
        assert.equal(block.startedAt, 0);
        assert.equal(block.endedAt, 0);
        assert.equal(block.redacted, undefined);
    });

    it("redacted thinking 块保留 redacted:true 标记,正文仍存在(渲染层负责隐藏)", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: "敏感内容", redacted: true }],
                    timestamp: 1,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[0].thinking.length, 1);
        assert.equal(ui[0].thinking[0]?.redacted, true);
    });

    it("多个 thinking 块按数组顺序保留", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [
                        { type: "thinking", thinking: "第一段思考" },
                        { type: "text", text: "中间回答" },
                        { type: "thinking", thinking: "第二段思考" },
                    ],
                    timestamp: 1,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.equal(ui[0].thinking.length, 2);
        assert.equal(ui[0].thinking[0]?.thinking, "第一段思考");
        assert.equal(ui[0].thinking[1]?.thinking, "第二段思考");
        assert.equal(ui[0].text, "中间回答");
    });

    it("无 thinking 块时 UiMessage.thinking 是空数组,不报错", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "e1",
                type: "message",
                timestamp: "2026-01-01T00:00:00Z",
                payload: {
                    role: "assistant",
                    content: [{ type: "text", text: "直接回答" }],
                    timestamp: 1,
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "assistant") throw new Error("narrow");
        assert.deepEqual(ui[0].thinking, []);
    });
});

describe("extractAssistantTextAndThinking", () => {
    it("从 AssistantMessage snapshot 同时取出 text 和 thinking", () => {
        const m: MessageLike = {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "考虑中" },
                { type: "text", text: "结论" },
            ],
        };
        const { text, thinking } = extractAssistantTextAndThinking(m as never);
        assert.equal(text, "结论");
        assert.equal(thinking.length, 1);
        assert.equal(thinking[0]?.thinking, "考虑中");
        assert.equal(thinking[0]?.startedAt, 0);
        assert.equal(thinking[0]?.endedAt, 0);
    });

    it("非 assistant message 返回空 text 和空 thinking 数组", () => {
        const m: MessageLike = { role: "user", content: "hi" };
        const { text, thinking } = extractAssistantTextAndThinking(m as never);
        assert.equal(text, "");
        assert.deepEqual(thinking, []);
    });

    it("undefined 输入返回空 text 和空 thinking 数组", () => {
        const { text, thinking } = extractAssistantTextAndThinking(undefined);
        assert.equal(text, "");
        assert.deepEqual(thinking, []);
    });
});

describe("historyToUiMessages — user image attachments", () => {
    it("user message 含 image content part 时,images 字段被填上", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "u1",
                type: "message",
                timestamp: "2026-07-16T10:00:00.000Z",
                payload: {
                    role: "user",
                    content: [
                        { type: "text", text: "看这张图" },
                        { type: "image", data: "AAAA", mimeType: "image/png" },
                    ],
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        assert.equal(ui.length, 1);
        if (ui[0].kind !== "user") throw new Error("narrow");
        assert.equal(ui[0].text, "看这张图");
        assert.deepEqual(ui[0].images, [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    });

    it("user message 只有 text 时,images 字段缺失", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "u1",
                type: "message",
                timestamp: "2026-07-16T10:00:00.000Z",
                payload: { role: "user", content: "hi" },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "user") throw new Error("narrow");
        assert.equal(ui[0].text, "hi");
        assert.equal(ui[0].images, undefined);
    });

    it("user message 含多张图 + 文本时,顺序保持", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "u1",
                type: "message",
                timestamp: "2026-07-16T10:00:00.000Z",
                payload: {
                    role: "user",
                    content: [
                        { type: "image", data: "png-data", mimeType: "image/png" },
                        { type: "text", text: "再看看" },
                        { type: "image", data: "jpg-data", mimeType: "image/jpeg" },
                    ],
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "user") throw new Error("narrow");
        assert.equal(ui[0].text, "再看看");
        assert.equal(ui[0].images?.length, 2);
        assert.deepEqual(ui[0].images?.[0], {
            type: "image",
            data: "png-data",
            mimeType: "image/png",
        });
        assert.deepEqual(ui[0].images?.[1], {
            type: "image",
            data: "jpg-data",
            mimeType: "image/jpeg",
        });
    });

    it("user message content 为空数组(纯图 prompt),text 为空且 images 填上", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "u1",
                type: "message",
                timestamp: "2026-07-16T10:00:00.000Z",
                payload: {
                    role: "user",
                    content: [{ type: "image", data: "x", mimeType: "image/gif" }],
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "user") throw new Error("narrow");
        assert.equal(ui[0].text, "");
        assert.equal(ui[0].images?.length, 1);
        assert.equal(ui[0].images?.[0]?.mimeType, "image/gif");
    });

    it("image part 缺 data/mimeType 时被静默丢弃,不抛错", () => {
        const entries: HistoryEntryLike[] = [
            {
                id: "u1",
                type: "message",
                timestamp: "2026-07-16T10:00:00.000Z",
                payload: {
                    role: "user",
                    content: [
                        { type: "image", data: "ok", mimeType: "image/png" },
                        { type: "image" }, // missing data
                        { type: "image", data: "no-mime" }, // missing mimeType
                    ],
                },
            },
        ];
        const ui = historyToUiMessages(entries);
        if (ui[0].kind !== "user") throw new Error("narrow");
        // Only one valid image is retained
        assert.equal(ui[0].images?.length, 1);
        assert.equal(ui[0].images?.[0]?.data, "ok");
    });
});

describe("historyToUiMessages — orphaned toolCall without toolResult", () => {
    /**
     * sidecar is killed while shell is awaiting approval; toolResult never hit disk.
     * On replay it must not spin forever — that turn is gone with the process and
     * can no longer receive a result.
     */
    const orphanEntries: HistoryEntryLike[] = [
        {
            id: "e1",
            type: "message",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { role: "user", content: "curl localhost", timestamp: 1 },
        },
        {
            id: "e2",
            type: "message",
            timestamp: "2026-01-01T00:00:01Z",
            payload: {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "call-done",
                        name: "shell",
                        arguments: { command: "pwd" },
                    },
                    {
                        type: "toolCall",
                        id: "call-orphan",
                        name: "shell",
                        arguments: { command: "curl" },
                    },
                ],
                timestamp: 2,
            },
        },
        {
            id: "e3",
            type: "message",
            timestamp: "2026-01-01T00:00:02Z",
            payload: {
                role: "toolResult",
                toolCallId: "call-done",
                toolName: "shell",
                content: "/tmp",
                isError: false,
                timestamp: 3,
            },
        },
    ];

    it("把悬挂的 toolCall 标为 error,不留在 running", () => {
        const ui = historyToUiMessages(orphanEntries);
        const assistant = ui.find((m) => m.kind === "assistant");
        assert.ok(assistant && assistant.kind === "assistant");
        if (assistant.kind !== "assistant") return;
        const orphan = assistant.tools.find((t) => t.id === "call-orphan");
        assert.equal(orphan?.status, "error");
        assert.equal(
            (orphan?.details as { reason?: string } | undefined)?.reason,
            "sidecar_restarted",
        );
    });

    it("有 toolResult 的 toolCall 状态不受影响", () => {
        const ui = historyToUiMessages(orphanEntries);
        const assistant = ui.find((m) => m.kind === "assistant");
        if (assistant?.kind !== "assistant") return assert.fail("no assistant");
        assert.equal(assistant.tools.find((t) => t.id === "call-done")?.status, "ok");
    });
});

describe("historyToUiMessages — 长耗时工具不被 expire", () => {
    /**
     * `agent` / `skill` spawn a child session and report minutes later, so a
     * history read taken mid-turn legitimately lacks their toolResult. Expiring
     * them would flip the card to error and strip `details.subSessionId`, which
     * the agent view surfaces as "no sub-session id (tool failed)".
     */
    const inFlight = (toolName: string): HistoryEntryLike[] => [
        {
            id: "e1",
            type: "message",
            timestamp: "2026-01-01T00:00:00Z",
            payload: { role: "user", content: "explore the repo", timestamp: 1 },
        },
        {
            id: "e2",
            type: "message",
            timestamp: "2026-01-01T00:00:01Z",
            payload: {
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: "call-long-1",
                        name: toolName,
                        arguments: { subagent_type: "explorer" },
                    },
                ],
                timestamp: 2,
            },
        },
    ];

    const toolOf = (entries: HistoryEntryLike[]) => {
        const ui = historyToUiMessages(entries);
        const assistant = ui.find((m) => m.kind === "assistant");
        if (assistant?.kind !== "assistant") return assert.fail("no assistant");
        return assistant.tools.find((t) => t.id === "call-long-1");
    };

    for (const name of ["agent", "agentContinue", "skill"]) {
        it(`在飞的 ${name} 保持 running,不被标为 error`, () => {
            const tool = toolOf(inFlight(name));
            assert.equal(tool?.status, "running");
            assert.equal((tool?.details as { reason?: string } | undefined)?.reason, undefined);
        });
    }

    it("短耗时工具(shell)仍然被 expire — sidecar 重启场景不回归", () => {
        assert.equal(toolOf(inFlight("shell"))?.status, "error");
    });

    /**
     * The inline `skill` path returns synchronously, so its toolResult always
     * lands in the same turn — `status` is already "ok" by the time the expire
     * pass runs and the LONG_RUNNING_TOOLS check is never consulted. This is
     * why the set needs no `runAs` discriminator: status is the discriminator.
     */
    it("已完成的 skill 判为 ok,不受长耗时豁免影响", () => {
        const entries: HistoryEntryLike[] = [
            ...inFlight("skill"),
            {
                id: "e3",
                type: "message",
                timestamp: "2026-01-01T00:00:02Z",
                payload: {
                    role: "toolResult",
                    toolCallId: "call-long-1",
                    toolName: "skill",
                    content: 'Skill "fan-out-agents" activated.',
                    isError: false,
                    details: { skillName: "fan-out-agents", found: true, runAs: "inline" },
                    timestamp: 3,
                },
            },
        ];
        const tool = toolOf(entries);
        assert.equal(tool?.status, "ok");
        assert.equal((tool?.details as { runAs?: string } | undefined)?.runAs, "inline");
    });
});
