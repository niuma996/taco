/**
 * agentContinue tool — resume an existing subagent by `subSessionId`.
 *
 * Companion to `agent`: when the parent needs to send a follow-up message
 * to a subagent that's already been spawned, calling `agent` again would
 * create a brand-new session with no shared state. `agentContinue` re-uses
 * the existing session so the subagent sees the full prior conversation.
 *
 * Thin shell: calls `SubagentSpawnContext.continue` (injected per-session
 * by WorkspaceRuntime); returns the result text as `content` and
 * `{ subSessionId }` as `details`.
 *
 * The caller MUST be the same parent session that originally spawned the
 * subagent — the spawn context enforces that via JSONL metadata so a
 * different parent (or a stale tool_call_id) cannot reach into another
 * subagent's branch.
 */

import { type AgentContinueToolDetails, asSessionId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { SubagentSpawnContext } from "../agents/types.ts";
import type {
    AgentHarnessTool,
    Context,
    ExecutionToolContext,
    TextContent,
} from "../runtime/pi/types.ts";

export type AgentContinueTool = AgentHarnessTool<ExecutionToolContext>;

export function createAgentContinueTool(ctx: SubagentSpawnContext): AgentContinueTool {
    const continueSchema = Type.Object({
        subSessionId: Type.String({
            description:
                "The subagent session id returned by an earlier `agent` tool call. Must belong to the same parent session.",
        }),
        prompt: Type.String({
            description:
                "The follow-up message to send to the subagent. The subagent sees the full prior conversation.",
        }),
    });

    type AgentContinueInput = Static<typeof continueSchema>;

    return {
        name: "agentContinue",
        label: "agentContinue",
        description:
            "Send a follow-up message to an existing subagent. The subagent keeps its prior conversation, toolset, and profile — use this instead of `agent` when you already have a subSessionId. Safe to issue multiple `agentContinue` calls in the same turn when they target different subSessionIds — they run concurrently.",
        parameters: continueSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Send a follow-up to an existing subagent by subSessionId. The subagent retains its conversation history; only this new prompt is appended. Use this instead of spawning a fresh subagent when continuing the same task. Concurrent `agentContinue` calls in the same turn run in parallel as long as their `subSessionId`s differ.",
            mutates: true,
        },
        async execute(
            toolCallId: string,
            params: AgentContinueInput,
            _onUpdate: unknown,
            _context: ExecutionToolContext,
            _invocation: unknown,
            piContext: Context,
        ): Promise<{ content: TextContent[]; details: AgentContinueToolDetails }> {
            // pi 0.85 carries cancellation on the Context rather than a
            // dedicated parameter.
            const signal = piContext.abortSignal;
            const { subSessionId, resultText, isError } = await ctx.continue({
                parentToolCallId: toolCallId,
                subSessionId: asSessionId(params.subSessionId),
                prompt: params.prompt,
                signal,
            });
            const text = isError ? `subagent continue error: ${resultText}` : resultText;
            return {
                content: [{ type: "text", text }],
                details: { subSessionId },
            };
        },
    };
}
