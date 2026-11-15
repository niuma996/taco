import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId, RPC } from "@taco-ai/protocol";
import type { TacoToolContext } from "../../src/tools/context.ts";
import { createMemoryTool } from "../../src/tools/memory.ts";
import { createSessionReadTool } from "../../src/tools/sessionRead.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { sessionToolContext } from "../_helpers/toolContext.ts";

const workspace = asWorkspaceId("/work/project");
const sourceSessionId = asSessionId("original-session");
const reference = {
    action: "read" as const,
    memoryLayer: "current" as const,
    sourceId: "0123456789abcdef",
    id: "review-standard",
};

function context(overrides: Partial<TacoToolContext> = {}) {
    const calls: string[] = [];
    const ctx = sessionToolContext({
        workspace,
        call: (async (method: string) => {
            calls.push(method);
            if (method === RPC.memoryRead)
                return {
                    sourceId: reference.sourceId,
                    topic: {
                        content: "Saved review standard",
                        sources: [{ sessionId: sourceSessionId }],
                    },
                };
            if (method === RPC.sessionList)
                return {
                    sessions: [{ id: sourceSessionId, cwd: workspace, kind: "main" }],
                };
            if (method === RPC.sessionHistory)
                return {
                    entries: [
                        {
                            type: "message",
                            id: "original-question",
                            timestamp: "2026-11-15T00:00:00.000Z",
                            payload: { role: "user", content: "Remember this review standard." },
                        },
                    ],
                };
            throw new Error(`Unexpected RPC: ${method}`);
        }) as never,
        ...overrides,
    });
    return { ctx, calls };
}

describe("memory source recall", () => {
    it("returns a model-visible reference that sessionRead can consume", async () => {
        const { ctx } = context();
        const result = await invokeTool(createMemoryTool(), reference, ctx);
        const text = result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
        const sessionReference = text.match(/sessionRead (\{[^\n]+\})/)?.[1];
        assert.ok(sessionReference, "memory read must expose the source session reference");
        const params = JSON.parse(sessionReference);
        assert.deepEqual(params, { sessionId: sourceSessionId });
        const recalled = await invokeTool(createSessionReadTool(), params, ctx);
        assert.match(JSON.stringify(recalled.content), /Remember this review standard/);
    });

    for (const overrides of [{ isIm: true }, { sessionKind: "subagent" as const }]) {
        it(`does not expose recall metadata for ${JSON.stringify(overrides)}`, async () => {
            const { ctx, calls } = context(overrides);
            const result = await invokeTool(createMemoryTool(), reference, ctx);
            assert.deepEqual(result.content, [{ type: "text", text: "Saved review standard" }]);
            assert.deepEqual(calls, [RPC.memoryRead]);
        });
    }

    it("does not offer inherited memory sources as current-workspace history", async () => {
        const { ctx, calls } = context();
        const result = await invokeTool(
            createMemoryTool(),
            {
                ...reference,
                memoryLayer: "workspace",
            },
            ctx,
        );
        assert.deepEqual(result.content, [{ type: "text", text: "Saved review standard" }]);
        assert.deepEqual(calls, [RPC.memoryRead]);
    });

    it("keeps the memory readable when source sessions are unavailable", async () => {
        const { ctx } = context();
        const call = ctx.call;
        ctx.call = (async (method: string, ...args: unknown[]) => {
            if (method === RPC.sessionList) return { sessions: [] };
            return (call as (...args: unknown[]) => unknown)(method, ...args);
        }) as never;
        const result = await invokeTool(createMemoryTool(), reference, ctx);
        assert.doesNotMatch(JSON.stringify(result.content), /original-session/);
        assert.match(JSON.stringify(result.content), /Saved review standard/);
    });

    it("omits sources outside the current workspace and child sessions", async () => {
        for (const session of [
            { id: sourceSessionId, cwd: "/other", kind: "main" },
            { id: sourceSessionId, cwd: workspace, kind: "subagent" },
            { id: sourceSessionId, cwd: workspace, kind: "main", parentSessionId: "parent" },
        ]) {
            const { ctx } = context();
            const call = ctx.call;
            ctx.call = (async (method: string, ...args: unknown[]) => {
                if (method === RPC.sessionList) return { sessions: [session] };
                return (call as (...args: unknown[]) => unknown)(method, ...args);
            }) as never;
            const result = await invokeTool(createMemoryTool(), reference, ctx);
            assert.deepEqual(result.content, [{ type: "text", text: "Saved review standard" }]);
        }
    });

    it("keeps the body when history lookup fails without exposing the failure", async () => {
        const { ctx } = context();
        const call = ctx.call;
        ctx.call = (async (method: string, ...args: unknown[]) => {
            if (method === RPC.sessionList) throw new Error("private-history-error");
            return (call as (...args: unknown[]) => unknown)(method, ...args);
        }) as never;
        const result = await invokeTool(createMemoryTool(), reference, ctx);
        assert.deepEqual(result.content, [{ type: "text", text: "Saved review standard" }]);
    });

    it("retains a visible source even when newer source sessions were deleted", async () => {
        const { ctx } = context();
        const call = ctx.call;
        ctx.call = (async (method: string, ...args: unknown[]) => {
            if (method === RPC.memoryRead)
                return {
                    topic: {
                        content: "Saved review standard",
                        sources: [
                            { sessionId: sourceSessionId },
                            ...Array.from({ length: 5 }, (_, i) => ({ sessionId: `deleted-${i}` })),
                        ],
                    },
                };
            if (method === RPC.sessionList) {
                const params = args[1] as { query: string };
                return {
                    sessions:
                        params.query === sourceSessionId
                            ? [{ id: sourceSessionId, cwd: workspace, kind: "main" }]
                            : [],
                };
            }
            return (call as (...args: unknown[]) => unknown)(method, ...args);
        }) as never;
        const result = await invokeTool(createMemoryTool(), reference, ctx);
        assert.match(JSON.stringify(result.content), /original-session/);
    });
});
