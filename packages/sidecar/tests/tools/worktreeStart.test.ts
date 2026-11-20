import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import type { TacoToolContext } from "../../src/tools/context.ts";
import { createWorktreeStartTool } from "../../src/tools/worktreeStart.ts";
import type { WorktreeTurn } from "../../src/worktree/turnContext.ts";
import { withWorktreeTurn } from "../../src/worktree/turnContext.ts";

const context = {
    workspace: asWorkspaceId("/project"),
    sessionId: asSessionId("source"),
    sessionKind: "main",
    isIm: false,
    env: {},
} as unknown as TacoToolContext;

describe("worktreeStart", () => {
    it("hands the current user task and committed attachments to the managed service", async () => {
        let received: unknown;
        const tool = createWorktreeStartTool();
        const turn: WorktreeTurn = {
            sourceSessionId: asSessionId("source"),
            text: "refactor the parser",
            images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
            attachments: [
                {
                    path: "/tmp/source/file.txt",
                    name: "file.txt",
                    mimeType: "text/plain",
                    size: 1,
                    kind: "file",
                },
            ],
        };
        const onUpdate = () => {};
        await withWorktreeTurn(turn, async () => {
            const result = await tool.execute(
                "call",
                { name: "parser-refactor", base: "head" },
                onUpdate,
                {
                    ...context,
                    worktreeStart: async (request) => {
                        received = request;
                        return {
                            sourceWorkspace: context.workspace,
                            sourceSessionId: context.sessionId,
                            workspace: asWorkspaceId("/project/.taco/worktrees/parser-refactor"),
                            sessionId: asSessionId("target"),
                            path: "/project/.taco/worktrees/parser-refactor",
                            branch: "worktree/parser-refactor",
                        };
                    },
                } as TacoToolContext,
                {} as never,
                {} as never,
            );
            const block = result.content[0];
            assert.ok(block?.type === "text");
            assert.match(block.text, /Do not repeat the task/);
        });
        assert.deepEqual(received, {
            sourceWorkspace: context.workspace,
            sourceSessionId: context.sessionId,
            name: "parser-refactor",
            base: "head",
            task: "refactor the parser",
            images: turn.images,
            attachments: turn.attachments,
        });
    });

    it("refuses a leaked subagent or IM invocation", async () => {
        const tool = createWorktreeStartTool();
        for (const patch of [{ sessionKind: "subagent" }, { isIm: true }]) {
            await assert.rejects(
                tool.execute(
                    "call",
                    { name: "invalid" },
                    () => {},
                    {
                        ...context,
                        ...patch,
                        worktreeStart: async () => assert.fail("must not hand off"),
                    } as TacoToolContext,
                    {} as never,
                    {} as never,
                ),
                /local main session/,
            );
        }
    });
});
