/**
 * agent tool — delegates a task to a subagent (independent session).
 * Thin shell: calls SubagentSpawnContext.spawn (injected per-session by
 * WorkspaceRuntime); returns the result text as `content` and
 * { subSessionId, agentType } as `details`.
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentToolDetails } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { SubagentSpawnContext } from "../agents/types.ts";

export type AgentTool = AgentHarnessTool<ExecutionToolContext>;

const SUBAGENT_TYPE_HINTS = `
- explorer — read-only search/tracing; CANNOT modify files
- verification — adversarial tester: run builds, tests, checks; return PASS/FAIL/PARTIAL verdict`;

export function createAgentTool(ctx: SubagentSpawnContext, availableTypes: string[]): AgentTool {
    const MAX_TYPES_IN_DESCRIPTION = 20;
    const displayTypes = availableTypes.slice(0, MAX_TYPES_IN_DESCRIPTION);
    const overflow = availableTypes.length - displayTypes.length;
    const typeList =
        displayTypes.length > 0
            ? overflow > 0
                ? `${displayTypes.join(", ")} (${overflow} more, see agents.list)`
                : displayTypes.join(", ")
            : "(none configured)";

    const agentSchema = Type.Object({
        subagent_type: Type.String({
            description: `Which agent type to delegate to. Available types: ${typeList}.${SUBAGENT_TYPE_HINTS}`,
        }),
        description: Type.String({ description: "3-5 word task summary (for display)." }),
        prompt: Type.String({ description: "The task for the subagent to perform." }),
    });

    type AgentToolInput = Static<typeof agentSchema>;

    return {
        name: "agent",
        label: "agent",
        description: `Delegate a task to a subagent that runs in its own session with a constrained toolset. Available types: ${typeList}.${SUBAGENT_TYPE_HINTS} The subagent returns a text result when done. Safe to issue multiple \`agent\` calls in the same turn — each runs in its own session and they execute concurrently.`,
        parameters: agentSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Delegate to a subagent in its own session. Returns the subagent's last assistant text only — intermediate tool calls do not bubble back. Safe to issue multiple `agent` calls in the same turn: each spawns an independent sub-session and they run concurrently. Pick the subagent type by capability, not by tool overlap.",
            mutates: true,
        },
        async execute(
            toolCallId: string,
            params: AgentToolInput,
            signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            _context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: AgentToolDetails }> {
            const { subSessionId, resultText, isError } = await ctx.spawn({
                parentToolCallId: toolCallId,
                agentType: params.subagent_type,
                prompt: params.prompt,
                signal,
            });
            const text = isError ? `subagent error: ${resultText}` : resultText;
            return {
                content: [{ type: "text", text }],
                details: {
                    agentType: params.subagent_type,
                    ...(subSessionId ? { subSessionId } : {}),
                },
            };
        },
    };
}
