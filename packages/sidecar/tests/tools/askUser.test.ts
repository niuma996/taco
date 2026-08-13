/**
 * askUser tool — execute branch unit tests.
 *
 * Covers:
 *   - First call (no answers): returns waiting=true + terminate=true
 *   - Second call (with answers): returns waiting=false, no terminate
 *   - annotation.preview / notes appear correctly in answers output
 *   - multiSelect string[] answers round-trip to details
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { TextContent } from "@earendil-works/pi-ai";
import { createAskUserTool } from "../../src/tools/askUser.ts";

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
        const result = await tool.execute(
            "tc-1",
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
            undefined,
            undefined,
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
        const result = await tool.execute(
            "tc-1",
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
            undefined,
            undefined,
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
        const result = await tool.execute(
            "tc-1",
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
            undefined,
            undefined,
            mockContext,
        );
        const text = textOf(result);
        assert.match(text, /selected preview:/);
        assert.match(text, /host: localhost/);
        assert.match(text, /user notes: tested/);
    });

    it("multiSelect answers as string[] round-trip in details", async () => {
        const tool = createAskUserTool();
        const result = await tool.execute(
            "tc-1",
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
            undefined,
            undefined,
            mockContext,
        );
        const details = result.details as { waiting?: boolean; answers?: unknown };
        assert.deepEqual(details.answers, { "Pick tags": ["fast", "cheap"] });
    });
});
