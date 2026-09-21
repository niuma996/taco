/**
 * agentAbort tool — stop one running subagent by `subSessionId` without
 * aborting the parent turn. Thin shell over SubagentSpawnContext.abortSubagent
 * (injected per-session by WorkspaceRuntime, restricted to the calling
 * session's own children).
 *
 * The stop is asynchronous: this tool only fires the child's abort
 * controller. A synchronous subagent's `agent`/`agentContinue` call returns
 * an interruption result explaining the stop; a background one settles with
 * outcome "aborted" and its notice says so.
 */

import { asSessionId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { SubagentSpawnContext } from "../agents/types.ts";
import type { AgentHarnessTool, ExecutionToolContext, TextContent } from "../runtime/pi/types.ts";

export type AgentAbortTool = AgentHarnessTool<ExecutionToolContext>;

export function createAgentAbortTool(ctx: SubagentSpawnContext): AgentAbortTool {
    const schema = Type.Object({
        subSessionId: Type.String({
            description:
                "The subagent's session id, from the `agent` tool's result or launch receipt.",
        }),
    });

    type AgentAbortInput = Static<typeof schema>;

    return {
        name: "agentAbort",
        label: "agentAbort",
        description:
            "Stop a running subagent without waiting for it. Use when a subagent you launched is no longer needed — e.g. the user changed direction, or a background subagent's result would arrive too late to matter. The subagent's own call learns it was stopped deliberately; do not respawn it for the same task unless asked.",
        parameters: schema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Stop a running subagent by subSessionId. Deliberate stop, not a failure — the subagent's pending call is told so.",
            mutates: true,
        },
        execute(
            _toolCallId: string,
            params: AgentAbortInput,
            _onUpdate: unknown,
            _context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: { stopped: boolean } }> {
            const { stopped } = ctx.abortSubagent({
                subSessionId: asSessionId(params.subSessionId),
            });
            const text = stopped
                ? `Stop requested for subagent ${params.subSessionId} — it is being aborted. Its pending call (or background completion notice) will report it as stopped.`
                : `Subagent ${params.subSessionId} is not running — it already settled, or the id is not one of this session's running subagents.`;
            return Promise.resolve({ content: [{ type: "text", text }], details: { stopped } });
        },
    };
}
