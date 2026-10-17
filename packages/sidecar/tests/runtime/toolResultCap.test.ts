/**
 * Harness-level tool result cap — the backstop for tools without their own limit.
 *
 * Run:
 *   pnpm exec tsx --test tests/runtime/toolResultCap.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { capToolResult } from "../../src/runtime/harness/toolResultCap.ts";

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function textOf(parts: readonly Part[] | undefined): string {
    return (parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
}

describe("capToolResult", () => {
    it("leaves a result under the cap untouched", () => {
        assert.equal(capToolResult({ content: [{ type: "text", text: "ok" }] }, 100), undefined);
    });

    it("keeps head and tail of an oversized result within the cap", () => {
        const text = `HEAD${"x".repeat(50_000)}TAIL`;
        const patch = capToolResult({ content: [{ type: "text", text }] }, 10_000);
        const out = textOf(patch?.content as Part[]);
        assert.ok(out.startsWith("HEAD"));
        assert.ok(out.endsWith("TAIL"));
        assert.match(out, /chars omitted/);
        // The marker adds a short fixed overhead on top of the kept budget.
        assert.ok(out.length < 10_300, `got ${out.length}`);
    });

    it("keeps a small header part whole while clipping the large body", () => {
        const header = "exit code: 1";
        const body = "y".repeat(200_000);
        const patch = capToolResult(
            {
                content: [
                    { type: "text", text: header },
                    { type: "text", text: body },
                ],
            },
            10_000,
        );
        const parts = patch?.content as Part[];
        assert.equal(parts[0].type === "text" && parts[0].text, header);
        assert.ok(textOf(parts).length < 10_500);
    });

    it("passes image parts through", () => {
        const image: Part = { type: "image", data: "AAAA", mimeType: "image/png" };
        const patch = capToolResult(
            { content: [image, { type: "text", text: "z".repeat(5_000) }] },
            1_000,
        );
        assert.deepEqual((patch?.content as Part[])[0], image);
    });
});

describe("wireHarnessHooks — tool result cap", () => {
    it("registers the cap after extension tool_result hooks", async () => {
        const { createModels } = await import("@earendil-works/pi-ai/compat");
        const { wireHarnessHooks } = await import("../../src/runtime/harness/hookWiring.ts");
        type AfterTool = (event: Record<string, unknown>) => Promise<unknown>;
        const afterTool: AfterTool[] = [];
        const harness = {
            hooks: {
                on(type: string, handler: AfterTool) {
                    if (type === "after_tool") afterTool.push(handler);
                    return () => {};
                },
            },
        };
        // An extension that inflates the result: the cap must still have the last word.
        const inflate = () => ({ content: [{ type: "text" as const, text: "w".repeat(500_000) }] });
        await wireHarnessHooks(harness as never, {} as never, {
            cwd: "/tmp/ws",
            getThinkingLevel: () => "off",
            models: createModels(),
            extensionToolResultHooks: { builtins: [inflate], external: [] },
        });
        let current: Record<string, unknown> = {
            toolCallId: "t",
            toolName: "mcp__x",
            args: {},
            content: [{ type: "text", text: "small" }],
            isError: false,
        };
        for (const handler of afterTool) {
            const patch = (await handler(current)) as { content?: unknown } | undefined;
            if (patch?.content !== undefined) current = { ...current, content: patch.content };
        }
        assert.ok(textOf(current.content as Part[]).length < 101_000);
    });
});
