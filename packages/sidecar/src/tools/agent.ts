/**
 * agent tool — delegates a task to a subagent (independent session).
 * Thin shell: calls SubagentSpawnContext.spawn (injected per-session by
 * WorkspaceRuntime).
 *
 * Two result shapes, discriminated by `details.status`:
 *  - synchronous (default, `background` omitted or `false`): blocks until the
 *    child finishes; `content` is the child's final answer, `details.status`
 *    is `"completed"`.
 *  - background (`background: true`): returns as soon as the child session
 *    exists; `content` is a receipt, not an answer — the real result arrives
 *    later as an injected message in this session (see `subagentDelivery.ts`
 *    on the sidecar side). `details.status` is `"launched"`.
 *
 * The tool's own `onUpdate` is forwarded so the spawn can publish progress
 * before it returns (synchronous path only — a launched background spawn has
 * no more progress to report on this call).
 */

import type { AgentToolDetails } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { SubagentSpawnContext } from "../agents/types.ts";
import type {
    AgentHarnessTool,
    AgentHarnessToolUpdateCallback,
    Context,
    ExecutionToolContext,
    TextContent,
} from "../runtime/pi/types.ts";

export type AgentTool = AgentHarnessTool<ExecutionToolContext>;

/**
 * What the model needs to pick a `subagent_type`. A structural subset of
 * `AgentDefinition` so this layer does not depend on the loader's shape.
 *
 * `availableTypes` used to be `string[]`, which meant the hint block was a
 * hardcoded blurb covering only the builtins: every user-defined agent reached
 * the model as a bare name with no capability description, and the blurb drifted
 * out of step with frontmatter whenever a profile was overridden.
 */
export interface AgentTypeDescriptor {
    agentType: string;
    /** One-line capability summary from frontmatter. May be empty. */
    description?: string;
    /** Longer selection guidance from frontmatter; preferred over description when present. */
    whenToUse?: string;
    /** Resolved default context mode; "fork" is called out since it costs more. */
    context?: "independent" | "fork";
}

export function createAgentTool(
    ctx: SubagentSpawnContext,
    _availableTypes: readonly AgentTypeDescriptor[],
): AgentTool {
    const agentSchema = Type.Object({
        subagent_type: Type.String({
            description:
                "Name of a registered agent type. Types are listed in the system prompt's <available_agents> section.",
        }),
        description: Type.String({ description: "3-5 word task summary (for display)." }),
        prompt: Type.String({ description: "The task for the subagent to perform." }),
        context: Type.Optional(
            Type.Union([Type.Literal("independent"), Type.Literal("fork")], {
                description:
                    'Context mode. Omit to use the agent type\'s configured default. "fork" additionally gives the subagent a transcript of this conversation up to now — use it when the task depends on what was already discussed or discovered.',
            }),
        ),
        background: Type.Optional(
            Type.Boolean({
                description:
                    "Run this subagent in the background instead of waiting for it. Default false " +
                    "(wait for the result). Set true for long-running, independent work — you get back " +
                    "a launch receipt immediately and can keep working. When it finishes you are " +
                    "notified with the path its output was written to; read that file when you need " +
                    "the detail. The launch receipt names that path up front, so you can also read " +
                    "it yourself to check whether the subagent has finished — a missing file means " +
                    "still running. Use this only when the result does not affect your next few steps: " +
                    "if you need the answer to decide what to do next, run it synchronously instead " +
                    "rather than launching it and waiting. Do NOT call `agent` again for the same " +
                    "task while it is running, and do not poll for it. Background subagents should " +
                    "not write to the same files as work you or another subagent are doing " +
                    "concurrently: there is no locking, so the last write wins silently.",
            }),
        ),
    });

    type AgentToolInput = Static<typeof agentSchema>;

    return {
        name: "agent",
        label: "agent",
        description:
            "Delegate a task to a subagent that runs in its own session with a constrained toolset. " +
            "Pick `subagent_type` from the system prompt's <available_agents> section. " +
            "The subagent returns a text result when done. Safe to issue multiple `agent` calls in the same turn — " +
            "each runs in its own session and they execute concurrently. Pass `background: true` to launch a " +
            "long-running subagent without waiting — its result arrives later as a message in this conversation " +
            "instead of in this tool's result.",
        parameters: agentSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Delegate to a subagent in its own session. Returns the subagent's last assistant text only — intermediate tool calls do not bubble back. Safe to issue multiple `agent` calls in the same turn: each spawns an independent sub-session and they run concurrently. Pick the subagent type by capability, not by tool overlap. `background: true` launches without waiting; the result arrives later as a message in this session, not in the tool result. Do not launch a background subagent whose task overlaps files another running background subagent is editing.",
            mutates: true,
        },
        async execute(
            toolCallId: string,
            params: AgentToolInput,
            onUpdate: AgentHarnessToolUpdateCallback<AgentToolDetails>,
            _context: ExecutionToolContext,
            _invocation: unknown,
            piContext: Context,
        ): Promise<{ content: TextContent[]; details: AgentToolDetails }> {
            // pi 0.85 carries cancellation on the Context rather than a
            // dedicated parameter. Only meaningful for the synchronous path —
            // a background spawn gets its own timeout-driven AbortController
            // instead (see agentSpawner.ts), since it must outlive this call.
            const signal = piContext.abortSignal;
            const { subSessionId, resultText, isError, background, resultPath } = await ctx.spawn({
                parentToolCallId: toolCallId,
                agentType: params.subagent_type,
                prompt: params.prompt,
                // Forwarded for the background path only, where the completion
                // notice may arrive many turns after this call: by then the
                // conversation has moved on, and a compaction may have replaced
                // the tool call that would otherwise identify what the subagent
                // was for. Echoing it back makes the notice self-describing.
                description: params.description,
                context: params.context,
                background: params.background,
                signal,
                onUpdate,
            });
            if (background) {
                // subSessionId is always present here — a background spawn
                // that failed before the child existed reports isError instead
                // (unknown agentType, concurrency limit) and background=false.
                // The receipt names the result file even though it does not
                // exist yet. That is deliberate: it makes the result
                // self-recoverable. If the completion notice never arrives (the
                // parent was mid-compaction, the process restarted), the model
                // still holds the exact path, and the file's absence is itself
                // the answer to "has it finished yet?" — no polling tool needed.
                const text = isError
                    ? `failed to launch background subagent: ${resultText}`
                    : `Subagent ${params.subagent_type} launched in background as session ${subSessionId}. ` +
                      "Its result will arrive as a message in this conversation once it finishes — do NOT " +
                      "spawn it again or poll for it. Continue with other work now." +
                      (resultPath
                          ? `\nWhen it finishes, its output will be at: ${resultPath}\n` +
                            "That file does not exist yet. If you are ever asked whether this subagent " +
                            "is done and no completion notice has arrived, read that path: if it reads, " +
                            "the subagent finished and that is its result; if it does not exist, it is " +
                            "still running."
                          : "");
                return {
                    content: [{ type: "text", text }],
                    details: subSessionId
                        ? { status: "launched", subSessionId, agentType: params.subagent_type }
                        : { status: "completed", agentType: params.subagent_type },
                };
            }
            const body = isError ? `subagent error: ${resultText}` : resultText;
            // `details` never reaches the model, so the id `agentContinue`
            // and `agentAbort` need has to ride in the text. Without it a
            // synchronous call left the model unable to follow up, and it
            // would guess an id instead.
            const text = subSessionId ? `${body}\n\n[subagent session: ${subSessionId}]` : body;
            return {
                content: [{ type: "text", text }],
                details: {
                    status: "completed",
                    agentType: params.subagent_type,
                    ...(subSessionId ? { subSessionId } : {}),
                },
            };
        },
    };
}
