/**
 * chatUtils pure-function tests — Node 22 built-in `node:test` runner via tsx.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:utils
 *
 * No new dependencies. Only covers pure functions in chatUtils.ts
 * (historyToUiMessages id-join + summarizeKnownArgFields). UI rendering is out of scope.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    extractAssistantTextAndThinking,
    findPendingAskUserIds,
    foldContent,
    type HistoryEntryLike,
    historyToUiMessages,
    isLastInTurn,
    isTurnInProgress,
    type MessageLike,
    parseEntryTimestamp,
    queuedItemsFromEvent,
    stringifyResult,
    summarizeKnownArgFields,
    toolResultLine,
    type UiMessage,
    type UiThinkingBlock,
    type UiToolCall,
} from "../../../src/lib/chat/chatUtils";

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

describe("summarizeKnownArgFields", () => {
    it("path 类字段用 shortPath", () => {
        const s = summarizeKnownArgFields({ path: "/Users/me/projects/foo/bar.ts" });
        assert.ok(s.length > 0);
        assert.ok(s.startsWith("…"));
    });
    it("command 字段原文显示(>80 字符截断)", () => {
        const cmd = "x".repeat(120);
        const s = summarizeKnownArgFields({ command: cmd });
        assert.ok(s.endsWith("…"));
        assert.equal(s.length, 81);
    });
    it("字段探测顺序:path 优先于 command", () => {
        assert.equal(summarizeKnownArgFields({ command: "ls", path: "a.ts" }), "a.ts");
    });
    it("file_path / filePath 同样识别", () => {
        assert.equal(summarizeKnownArgFields({ file_path: "a.ts" }), "a.ts");
        assert.equal(summarizeKnownArgFields({ filePath: "a.ts" }), "a.ts");
    });
    it("空字符串字段视为缺失", () => {
        assert.equal(summarizeKnownArgFields({ path: "" }), "");
    });
    it("无匹配字段时返回空 — 不再 dump JSON", () => {
        // The exact arguments belong in the card's raw-args disclosure; a
        // truncated JSON fragment in the header was unreadable and consumed the
        // whole line.
        assert.equal(summarizeKnownArgFields({ weird: "thing" }), "");
        assert.equal(summarizeKnownArgFields({ listName: "L", tasks: [{ content: "a" }] }), "");
        assert.equal(summarizeKnownArgFields({ blob: "x".repeat(120) }), "");
    });
    it("args 不是对象时返回空", () => {
        assert.equal(summarizeKnownArgFields(null), "");
        assert.equal(summarizeKnownArgFields("raw"), "");
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

    /**
     * `inFlightAgentToolCallIds` comes from `session.attach` and reflects sidecar
     * process memory. It is the only signal that separates "subagent still
     * working" from "subagent died with a previous process" — absence of a
     * toolResult looks identical in both cases.
     */
    describe("已知在飞集合时按集合判定", () => {
        const toolWithInFlight = (toolName: string, ids: string[]) => {
            const ui = historyToUiMessages(inFlight(toolName), {
                inFlightAgentToolCallIds: ids,
            });
            const assistant = ui.find((m) => m.kind === "assistant");
            if (assistant?.kind !== "assistant") return assert.fail("no assistant");
            return assistant.tools.find((t) => t.id === "call-long-1");
        };

        for (const name of ["agent", "agentContinue", "skill"]) {
            it(`${name} 在集合内 → 保持 running`, () => {
                const tool = toolWithInFlight(name, ["call-long-1"]);
                assert.equal(tool?.status, "running");
                assert.equal((tool?.details as { reason?: string } | undefined)?.reason, undefined);
            });

            it(`${name} 不在集合内 → 判为 error(进程已退出的孤儿卡片)`, () => {
                const tool = toolWithInFlight(name, []);
                assert.equal(tool?.status, "error");
                const details = tool?.details as
                    | { reason?: string; interrupted?: boolean }
                    | undefined;
                assert.equal(details?.reason, "subagent_orphaned");
                assert.equal(details?.interrupted, true);
            });
        }

        it("空集合不影响短耗时工具的既有过期行为", () => {
            const ui = historyToUiMessages(inFlight("shell"), { inFlightAgentToolCallIds: [] });
            const assistant = ui.find((m) => m.kind === "assistant");
            if (assistant?.kind !== "assistant") return assert.fail("no assistant");
            assert.equal(assistant.tools.find((t) => t.id === "call-long-1")?.status, "error");
        });
    });
});

describe("foldContent", () => {
    it("returns a string value as-is", () => {
        assert.equal(foldContent("plain"), "plain");
    });

    it("joins text parts with newlines, skipping non-text and empty parts", () => {
        const parts = [
            { type: "text", text: "first" },
            { type: "image", data: "…", mimeType: "image/png" },
            { type: "text", text: "" },
            { type: "text", text: "second" },
        ];
        assert.equal(foldContent(parts), "first\nsecond");
    });

    it("falls back to JSON for objects it does not understand", () => {
        assert.equal(foldContent({ a: 1 }), '{"a":1}');
    });

    it("maps every falsy value to the empty string", () => {
        for (const v of [undefined, null, "", 0, false]) {
            assert.equal(foldContent(v), "");
        }
    });
});

describe("stringifyResult", () => {
    it("unwraps the { content: Part[] } tool_end shape", () => {
        const result = { content: [{ type: "text", text: "done" }], details: { edits: 1 } };
        assert.equal(stringifyResult(result), "done");
    });

    it("folds a bare value that has no content wrapper", () => {
        assert.equal(stringifyResult("raw"), "raw");
        assert.equal(stringifyResult({ ok: true }), '{"ok":true}');
    });

    it("JSON-dumps a non-array content field rather than unwrapping it", () => {
        // Only an array content is the wire shape; a string content is data.
        assert.equal(stringifyResult({ content: "text" }), '{"content":"text"}');
    });

    it("returns the empty string for falsy results", () => {
        assert.equal(stringifyResult(undefined), "");
        assert.equal(stringifyResult(null), "");
    });
});

describe("toolResultLine", () => {
    it("marks success with a check and the folded text", () => {
        assert.equal(toolResultLine("read", false, "content"), "✓ read: content");
    });

    it("marks errors with a cross and an (error) tag", () => {
        assert.equal(toolResultLine("shell", true, "boom"), "✗ shell (error): boom");
    });

    it("omits the colon suffix when there is no text", () => {
        // Guards the branch that used to be a separate `if (!result)` early return.
        assert.equal(toolResultLine("read", false, ""), "✓ read");
        assert.equal(toolResultLine("read", true, ""), "✗ read (error)");
    });

    it("truncates at 240 chars with an ellipsis", () => {
        const line = toolResultLine("read", false, "x".repeat(300));
        assert.equal(line, `✓ read: ${"x".repeat(240)}…`);
    });

    it("leaves text at exactly the limit untruncated", () => {
        const line = toolResultLine("read", false, "x".repeat(240));
        assert.equal(line, `✓ read: ${"x".repeat(240)}`);
    });
});

describe("parseEntryTimestamp", () => {
    // Both shapes are live: session.history sends ISO strings, the harness
    // stores epoch millis. Handling only one substitutes "now" for the other,
    // so every history row gets stamped with the load time — wrong ordering and
    // a wrong clock, with nothing raised.
    it("accepts epoch millis", () => {
        assert.equal(parseEntryTimestamp(1_700_000_000_000, 42), 1_700_000_000_000);
    });

    it("accepts an ISO string", () => {
        assert.equal(
            parseEntryTimestamp("2026-01-01T00:00:00.000Z", 42),
            Date.parse("2026-01-01T00:00:00.000Z"),
        );
    });

    it("keeps epoch 0 rather than treating it as absent", () => {
        assert.equal(parseEntryTimestamp(0, 42), 0);
    });

    it("falls back when the value is missing or unparseable", () => {
        assert.equal(parseEntryTimestamp(undefined, 42), 42);
        assert.equal(parseEntryTimestamp("not-a-date", 42), 42);
        assert.equal(parseEntryTimestamp(Number.NaN, 42), 42);
    });
});

describe("historyToUiMessages — entry timestamps", () => {
    const userEntry = (timestamp: string | number): HistoryEntryLike => ({
        id: "e1",
        type: "message",
        timestamp,
        payload: { role: "user", content: "hi" } as MessageLike,
    });

    it("preserves an epoch-millis timestamp instead of substituting now", () => {
        const ui = historyToUiMessages([userEntry(1_700_000_000_000)]);
        assert.equal(ui[0]?.ts, 1_700_000_000_000);
    });

    it("preserves an ISO timestamp", () => {
        const ui = historyToUiMessages([userEntry("2026-01-01T00:00:00.000Z")]);
        assert.equal(ui[0]?.ts, Date.parse("2026-01-01T00:00:00.000Z"));
    });
});

describe("queuedItemsFromEvent", () => {
    it("keys rows by entryId and keeps steer/followUp/nextRun kinds", () => {
        const rows = queuedItemsFromEvent({
            queues: [
                {
                    entryId: "e1",
                    kind: "steer",
                    message: { role: "user", content: "redirect" },
                },
                {
                    entryId: "e2",
                    kind: "followUp",
                    message: { role: "user", content: "later" },
                },
                {
                    entryId: "e3",
                    kind: "nextRun",
                    message: { role: "user", content: "next" },
                },
            ],
        });
        assert.deepEqual(rows, [
            { id: "e1", kind: "steer", text: "redirect" },
            { id: "e2", kind: "followUp", text: "later" },
            { id: "e3", kind: "nextRun", text: "next" },
        ]);
    });

    it("drops entries without an entryId — they could never be cancelled", () => {
        const rows = queuedItemsFromEvent({
            queues: [
                {
                    kind: "steer",
                    type: "message",
                    message: { role: "user", content: "orphan" },
                } as never,
            ],
        });
        assert.deepEqual(rows, []);
    });

    it("drops custom write entries (no message) and unknown kinds", () => {
        const rows = queuedItemsFromEvent({
            queues: [
                { entryId: "w1", kind: "steer", type: "write" } as never,
                {
                    entryId: "k1",
                    kind: "bogus",
                    type: "message",
                    message: { role: "user", content: "x" },
                } as never,
            ],
        });
        assert.deepEqual(rows, []);
    });

    it("returns [] when queues is missing or not an array", () => {
        assert.deepEqual(queuedItemsFromEvent({}), []);
        assert.deepEqual(queuedItemsFromEvent({ queues: "nope" as never }), []);
    });
});

/**
 * Turn-geometry helpers — where a message meta row (timestamp + copy button)
 * belongs, and whether the turn containing the message is still running.
 *
 * Decoupled from chat layout so they can be reasoned about and tested as pure
 * array predicates. ChatPane composes them with `sessionBusy` for the render
 * call.
 */
describe("isLastInTurn", () => {
    const user = (ts = 1): UiMessage => ({ id: "u", kind: "user", text: "hi", ts });
    const assistant = (ts = 2, tools: UiToolCall[] = []): UiMessage => ({
        id: "a",
        kind: "assistant",
        text: "",
        ts,
        tools,
        thinking: [],
    });
    const sys: UiMessage = { id: "s", kind: "system", text: "", ts: 0 };
    const orphanTool: UiMessage = { id: "t", kind: "tool", text: "", ts: 0 };

    it("user 永远是它所在 user 链的末尾(实际场景里 user 之间不连续)", () => {
        const msgs = [user(), assistant()];
        assert.equal(isLastInTurn(msgs, 0), true);
    });

    it("assistant 在 user 后接另一条 user 时,被标记为上一轮的末尾", () => {
        const msgs = [user(), assistant(), user()];
        assert.equal(isLastInTurn(msgs, 1), true);
    });

    it("assistant 后还有 assistant(同回合) → 不是末尾", () => {
        const msgs = [user(), assistant(), assistant(), user()];
        assert.equal(isLastInTurn(msgs, 1), false);
        assert.equal(isLastInTurn(msgs, 2), true);
    });

    it("assistant 在数组末尾 → 末尾", () => {
        const msgs = [user(), assistant()];
        assert.equal(isLastInTurn(msgs, 1), true);
    });

    it("system / orphan tool 永不为末尾", () => {
        assert.equal(isLastInTurn([sys], 0), false);
        assert.equal(isLastInTurn([orphanTool], 0), false);
    });

    it("空数组 / 越界下标 → false", () => {
        assert.equal(isLastInTurn([], 0), false);
        const msgs = [user()];
        assert.equal(isLastInTurn(msgs, 5), false);
    });
});

describe("isTurnInProgress", () => {
    it("user / system / tool 不视为 turn in progress", () => {
        const msgs: UiMessage[] = [
            { id: "u", kind: "user", text: "hi", ts: 1 },
            { id: "s", kind: "system", text: "", ts: 0 },
            { id: "t", kind: "tool", text: "", ts: 0 },
        ];
        assert.equal(isTurnInProgress(msgs, 0), false);
        assert.equal(isTurnInProgress(msgs, 1), false);
        assert.equal(isTurnInProgress(msgs, 2), false);
    });

    it("assistant 的 tools 全是 ok/error → 不算 in progress", () => {
        const msgs: UiMessage[] = [
            {
                id: "a",
                kind: "assistant",
                text: "",
                ts: 1,
                tools: [
                    { id: "t1", name: "read", args: {}, status: "ok" },
                    { id: "t2", name: "shell", args: {}, status: "error" },
                ],
                thinking: [],
            },
        ];
        assert.equal(isTurnInProgress(msgs, 0), false);
    });

    it("assistant 至少有一个 running tool → in progress(覆盖 shell / agent / askUser / planExit)", () => {
        const msgs: UiMessage[] = [
            {
                id: "a",
                kind: "assistant",
                text: "",
                ts: 1,
                tools: [
                    { id: "t1", name: "read", args: {}, status: "ok" },
                    { id: "t2", name: "askUser", args: {}, status: "running" },
                ],
                thinking: [],
            },
        ];
        assert.equal(isTurnInProgress(msgs, 0), true);
    });

    it("sessionBusy 单独也能把 assistant 标 in progress(覆盖纯文本 streaming)", () => {
        const msgs: UiMessage[] = [
            {
                id: "a",
                kind: "assistant",
                text: "thinking out loud…",
                ts: 1,
                tools: [],
                thinking: [],
            },
        ];
        assert.equal(isTurnInProgress(msgs, 0, false), false);
        assert.equal(isTurnInProgress(msgs, 0, true), true);
    });

    it("sessionBusy 对 user 消息没影响", () => {
        const msgs: UiMessage[] = [{ id: "u", kind: "user", text: "hi", ts: 1 }];
        assert.equal(isTurnInProgress(msgs, 0, true), false);
    });

    it("askUser 第一次 tool_end 后 status=ok 但 details.waiting=true → in progress", () => {
        // live path: handleToolEnd sets status="ok" on tool_end regardless of
        // waiting — but the card is still pending user input. Without the
        // waiting check we'd flip the meta row on too early.
        const msgs: UiMessage[] = [
            {
                id: "a",
                kind: "assistant",
                text: "",
                ts: 1,
                tools: [
                    {
                        id: "q1",
                        name: "askUser",
                        args: {},
                        status: "ok",
                        details: { questions: [{ question: "q" }], waiting: true },
                    },
                ],
                thinking: [],
            },
        ];
        assert.equal(isTurnInProgress(msgs, 0), true);
    });

    it("planExit details.waiting=true 同样算 in progress", () => {
        const msgs: UiMessage[] = [
            {
                id: "a",
                kind: "assistant",
                text: "",
                ts: 1,
                tools: [
                    {
                        id: "p1",
                        name: "planExit",
                        args: {},
                        status: "ok",
                        details: { waiting: true },
                    },
                ],
                thinking: [],
            },
        ];
        assert.equal(isTurnInProgress(msgs, 0), true);
    });

    it("askUser waiting=false 后视为已完成", () => {
        const msgs: UiMessage[] = [
            {
                id: "a",
                kind: "assistant",
                text: "",
                ts: 1,
                tools: [
                    {
                        id: "q1",
                        name: "askUser",
                        args: {},
                        status: "ok",
                        details: { waiting: false },
                    },
                ],
                thinking: [],
            },
        ];
        assert.equal(isTurnInProgress(msgs, 0), false);
    });

    it("details.waiting 是非 boolean 时不触发 in progress(防御性)", () => {
        // unknown / null / 字符串 等非 boolean 都不应当成 true 处理。
        const variants: unknown[] = [undefined, null, "yes", 1, {}];
        for (const waiting of variants) {
            const msgs: UiMessage[] = [
                {
                    id: "a",
                    kind: "assistant",
                    text: "",
                    ts: 1,
                    tools: [
                        {
                            id: "q1",
                            name: "askUser",
                            args: {},
                            status: "ok",
                            details: { waiting },
                        },
                    ],
                    thinking: [],
                },
            ];
            assert.equal(isTurnInProgress(msgs, 0), false, `waiting=${String(waiting)}`);
        }
    });
});
