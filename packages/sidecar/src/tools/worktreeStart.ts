import type { WorktreeHandoffParams } from "@taco-ai/protocol";
import { type Static, Type } from "typebox";
import { getWorktreeTurn } from "../worktree/turnContext.ts";
import type { TacoTool } from "./index.ts";

const schema = Type.Object({
    name: Type.String({
        minLength: 1,
        maxLength: 80,
        description:
            "Short lowercase hyphenated worktree name; the branch becomes worktree/<name>.",
    }),
    base: Type.Optional(
        Type.Union([Type.Literal("head"), Type.Literal("default")], {
            description: "Committed starting point. Defaults to the current checkout's HEAD.",
        }),
    ),
    task: Type.Optional(
        Type.String({
            minLength: 1,
            description:
                "Self-contained task for the new session. Normally omit this to hand off the current user message verbatim.",
        }),
    ),
});

type Input = Static<typeof schema>;

/** Main-session managed handoff; availability is decided by the per-turn Git probe. */
export function createWorktreeStartTool(): TacoTool {
    return {
        name: "worktreeStart",
        label: "Start isolated worktree task",
        description:
            "Create a Taco-managed Git worktree and hand the user's implementation task to a new session there. Use for complex, high-risk, or parallel-conflicting writes, or an explicit isolation request. The source session keeps its cwd. The new checkout contains committed content only.",
        parameters: schema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Create a managed worktree and continue the task in a new session there. For substantial, risky, or parallel-conflicting writes; not for read-only work or routine small edits.",
            mutates: true,
        },
        async execute(_toolCallId, params: Input, _onUpdate, context, _invocation, piContext) {
            if (context.sessionKind !== "main" || context.isIm || !context.worktreeStart)
                throw new Error(
                    "worktreeStart is available only in an eligible local main session",
                );
            const turn = getWorktreeTurn();
            const ownsTurn = turn?.sourceSessionId === context.sessionId ? turn : undefined;
            const task = params.task ?? ownsTurn?.text;
            if (!task?.trim() && !ownsTurn?.images?.length && !ownsTurn?.attachments?.length)
                throw new Error(
                    "worktreeStart requires a self-contained task outside an active user prompt",
                );
            const handoff = await context.worktreeStart({
                sourceWorkspace: context.workspace,
                sourceSessionId: context.sessionId,
                name: params.name,
                base: params.base,
                task: task ?? "",
                ...(ownsTurn?.images ? { images: ownsTurn.images } : {}),
                ...(ownsTurn?.attachments ? { attachments: ownsTurn.attachments } : {}),
                ...(piContext.abortSignal ? { signal: piContext.abortSignal } : {}),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Task handed off to session ${handoff.sessionId} in ${handoff.path} on ${handoff.branch}. Do not repeat the task or edit the same files in the source session.`,
                    },
                ],
                details: handoff satisfies WorktreeHandoffParams,
            };
        },
    };
}
