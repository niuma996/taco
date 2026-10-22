// askUser tool tests: execute branches and injected-context formatting.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AskUserQuestion } from "@taco-ai/protocol";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import type { TextContent } from "../../src/runtime/pi/types.ts";
import { createAskUserTool } from "../../src/tools/askUser.ts";
import {
    formatAskUserContextBody,
    resolveAskUserQuestions,
    wrapAskUserContext,
} from "../../src/tools/askUserInjectionText.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";

function textOf(result: { content: Array<{ type?: string; text?: string }> }): string {
    const c = result.content[0];
    if (c?.type !== "text") throw new Error("expected text content");
    return (c as TextContent).text;
}

describe("askUser tool — execute", () => {
    // askUser execute ignores context — pass minimal shape
    const mockContext = { env: new NodeExecutionEnv({ cwd: "/" }) };

    it("first call (no answers) → waiting=true + terminate=true", async () => {
        const tool = createAskUserTool();
        const result = await invokeTool(
            tool,
            {
                questions: [
                    {
                        question: "Which color?",
                        header: "Color",
                        multiSelect: false,
                        options: [
                            { label: "Red", description: "warm" },
                            { label: "Blue", description: "cool" },
                        ],
                    },
                ],
            },
            mockContext,
        );
        assert.equal(result.terminate, true);
        const details = result.details as { waiting?: boolean; questions?: unknown };
        assert.equal(details.waiting, true);
        assert.ok(Array.isArray(details.questions));
        assert.match(textOf(result), /Which color\?/);
    });

    it("second call (answers provided) → waiting=false, no terminate", async () => {
        const tool = createAskUserTool();
        const result = await invokeTool(
            tool,
            {
                questions: [
                    {
                        question: "Which color?",
                        header: "Color",
                        multiSelect: false,
                        options: [
                            { label: "Red", description: "warm" },
                            { label: "Blue", description: "cool" },
                        ],
                    },
                ],
                answers: { "Which color?": "Red" },
            },
            mockContext,
        );
        assert.equal(result.terminate, undefined);
        const details = result.details as { waiting?: boolean; answers?: unknown };
        assert.equal(details.waiting, false);
        assert.deepEqual(details.answers, { "Which color?": "Red" });
        assert.match(textOf(result), /User has answered/);
        assert.match(textOf(result), /Red/);
    });

    it("annotations.preview and notes appear in answers output", async () => {
        const tool = createAskUserTool();
        const result = await invokeTool(
            tool,
            {
                questions: [
                    {
                        question: "Pick a config",
                        header: "Cfg",
                        multiSelect: false,
                        options: [{ label: "Default", description: "ok" }],
                    },
                ],
                answers: { "Pick a config": "Default" },
                annotations: {
                    "Pick a config": { preview: "host: localhost\nport: 8080", notes: "tested" },
                },
            },
            mockContext,
        );
        const text = textOf(result);
        assert.match(text, /selected preview:/);
        assert.match(text, /host: localhost/);
        assert.match(text, /user notes: tested/);
    });

    it("multiSelect answers as string[] round-trip in details", async () => {
        const tool = createAskUserTool();
        const result = await invokeTool(
            tool,
            {
                questions: [
                    {
                        question: "Pick tags",
                        header: "Tags",
                        multiSelect: true,
                        options: [
                            { label: "fast", description: "speed" },
                            { label: "cheap", description: "cost" },
                        ],
                    },
                ],
                answers: { "Pick tags": ["fast", "cheap"] },
            },
            mockContext,
        );
        const details = result.details as { waiting?: boolean; answers?: unknown };
        assert.deepEqual(details.answers, { "Pick tags": ["fast", "cheap"] });
    });
});

const SAMPLE_QUESTIONS: AskUserQuestion[] = [
    {
        question: "Pick a color",
        header: "Color",
        options: [
            { label: "Red", description: "warm" },
            { label: "Blue", description: "cool" },
        ],
        multiSelect: false,
    },
];

describe("formatAskUserContextBody — byte-level compat with desktop legacy", () => {
    it("matches the exact desktop template for single-select, single-question", () => {
        const answers = { "Pick a color": "Red" };
        const out = formatAskUserContextBody("askUser", SAMPLE_QUESTIONS, answers);
        const expected = [
            "The user has answered your askUser questions.",
            "Please call the askUser tool again with the questions and answers below.",
            "questions (JSON):",
            JSON.stringify(SAMPLE_QUESTIONS, null, 2),
            "answers (JSON):",
            JSON.stringify(answers, null, 2),
        ].join("\n");
        assert.equal(out, expected);
    });

    it("uses toolName in both header lines (planExit reuse)", () => {
        const out = formatAskUserContextBody("planExit", SAMPLE_QUESTIONS, {
            "Pick a color": "Approve",
        });
        assert.match(out, /^The user has answered your planExit questions\./);
        assert.match(
            out,
            /Please call the planExit tool again with the questions and answers below\./,
        );
    });

    it("preserves multi-select answers as JSON arrays", () => {
        const multiQ: AskUserQuestion[] = [
            {
                question: "Pick fruits",
                header: "Fruits",
                options: [
                    { label: "Apple", description: "" },
                    { label: "Banana", description: "" },
                ],
                multiSelect: true,
            },
        ];
        const answers = { "Pick fruits": ["Apple", "Banana"] };
        const out = formatAskUserContextBody("askUser", multiQ, answers);
        // JSON.stringify with null,2 indents each element on its own line.
        assert.ok(out.includes('"Pick fruits"'));
        assert.ok(out.includes('"Apple"'));
        assert.ok(out.includes('"Banana"'));
    });

    it("handles multiple questions", () => {
        const qs: AskUserQuestion[] = [
            SAMPLE_QUESTIONS[0] as AskUserQuestion,
            {
                question: "Pick a size",
                header: "Size",
                options: [
                    { label: "S", description: "" },
                    { label: "M", description: "" },
                ],
                multiSelect: false,
            },
        ];
        const answers = { "Pick a color": "Blue", "Pick a size": "M" };
        const out = formatAskUserContextBody("askUser", qs, answers);
        assert.ok(out.includes("Pick a color"));
        assert.ok(out.includes("Pick a size"));
    });
});

describe("wrapAskUserContext", () => {
    it("wraps body in opening/closing tags with newlines", () => {
        const out = wrapAskUserContext("hello");
        assert.equal(out, "<ask_user_context>\nhello\n</ask_user_context>");
    });

    it("combined with formatAskUserContextBody matches the desktop final text", () => {
        const body = formatAskUserContextBody("askUser", SAMPLE_QUESTIONS, {
            "Pick a color": "Red",
        });
        const out = wrapAskUserContext(body);
        // desktop useWorkspaces.ts:162-163 produces:
        const desktopBody = `The user has answered your askUser questions.\nPlease call the askUser tool again with the questions and answers below.\nquestions (JSON):\n${JSON.stringify(SAMPLE_QUESTIONS, null, 2)}\nanswers (JSON):\n${JSON.stringify({ "Pick a color": "Red" }, null, 2)}`;
        const desktopText = `<ask_user_context>\n${desktopBody}\n</ask_user_context>`;
        assert.equal(out, desktopText);
    });
});

describe("resolveAskUserQuestions", () => {
    function makeAttachedWith(entries: unknown[]) {
        return {
            session: {
                branch: async () => ({ findEntries: async () => entries }),
            },
            // biome-ignore lint/suspicious/noExplicitAny: test fixture only.
        } as any;
    }

    it("returns questions when a waiting toolResult matches", async () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "askUser",
                    toolCallId: "tc-1",
                    details: { questions: SAMPLE_QUESTIONS, waiting: true },
                },
            },
        ];
        const attached = makeAttachedWith(entries);
        const out = await resolveAskUserQuestions(attached, "tc-1", "askUser");
        assert.deepEqual(out, SAMPLE_QUESTIONS);
    });

    it("returns null when waiting is false (already answered)", async () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "askUser",
                    toolCallId: "tc-1",
                    details: { questions: SAMPLE_QUESTIONS, waiting: false },
                },
            },
        ];
        const attached = makeAttachedWith(entries);
        const out = await resolveAskUserQuestions(attached, "tc-1", "askUser");
        assert.equal(out, null);
    });

    it("returns null when toolCallId does not match", async () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "askUser",
                    toolCallId: "tc-other",
                    details: { questions: SAMPLE_QUESTIONS, waiting: true },
                },
            },
        ];
        const attached = makeAttachedWith(entries);
        const out = await resolveAskUserQuestions(attached, "tc-1", "askUser");
        assert.equal(out, null);
    });

    it("returns null when toolName does not match", async () => {
        const entries = [
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "planExit",
                    toolCallId: "tc-1",
                    details: { questions: SAMPLE_QUESTIONS, waiting: true },
                },
            },
        ];
        const attached = makeAttachedWith(entries);
        const out = await resolveAskUserQuestions(attached, "tc-1", "askUser");
        assert.equal(out, null);
    });

    it("returns null when no entries", async () => {
        const attached = makeAttachedWith([]);
        const out = await resolveAskUserQuestions(attached, "tc-1", "askUser");
        assert.equal(out, null);
    });

    it("ignores non-message entries", async () => {
        const entries = [
            { type: "thinking_level_change", thinkingLevel: "off" },
            {
                type: "message",
                message: {
                    role: "user",
                    content: "hello",
                },
            },
            {
                type: "message",
                message: {
                    role: "toolResult",
                    toolName: "askUser",
                    toolCallId: "tc-1",
                    details: { questions: SAMPLE_QUESTIONS, waiting: true },
                },
            },
        ];
        const attached = makeAttachedWith(entries);
        const out = await resolveAskUserQuestions(attached, "tc-1", "askUser");
        assert.deepEqual(out, SAMPLE_QUESTIONS);
    });

    it("returns the most recent match when multiple waiting entries exist", async () => {
        const older = {
            type: "message",
            message: {
                role: "toolResult",
                toolName: "askUser",
                toolCallId: "tc-old",
                details: { questions: SAMPLE_QUESTIONS, waiting: true },
            },
        };
        const newer = {
            type: "message",
            message: {
                role: "toolResult",
                toolName: "askUser",
                toolCallId: "tc-new",
                details: { questions: SAMPLE_QUESTIONS, waiting: true },
            },
        };
        const attached = makeAttachedWith([older, newer]);
        const out = await resolveAskUserQuestions(attached, "tc-new", "askUser");
        assert.deepEqual(out, SAMPLE_QUESTIONS);
    });
});
