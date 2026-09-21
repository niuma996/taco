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

/** Collapse whitespace so a multi-line frontmatter string stays one bullet. */
function oneLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Render the per-type hint bullets from the loaded definitions.
 *
 * `whenToUse` wins over `description` because it is written to answer "should I
 * pick this one", which is exactly the decision being made here. Types with
 * neither still get a bullet — a bare name is worse, but omitting the type
 * entirely would hide that it is callable.
 */
function buildTypeHints(types: readonly AgentTypeDescriptor[]): string {
    if (types.length === 0) return "";
    const bullets = types.map((t) => {
        const summary = oneLine(t.whenToUse ?? t.description ?? "");
        const forkNote =
            t.context === "fork"
                ? " (defaults to forked context: it sees this conversation, which costs more than an independent spawn)"
                : "";
        return summary.length > 0
            ? `\n- ${t.agentType} — ${summary}${forkNote}`
            : `\n- ${t.agentType}${forkNote}`;
    });
    return bullets.join("");
}

export function createAgentTool(
    ctx: SubagentSpawnContext,
    availableTypes: readonly AgentTypeDescriptor[],
): AgentTool {
    const MAX_TYPES_IN_DESCRIPTION = 20;
    const displayTypes = availableTypes.slice(0, MAX_TYPES_IN_DESCRIPTION);
    const overflow = availableTypes.length - displayTypes.length;
    const names = displayTypes.map((t) => t.agentType);
    const typeList =
        names.length > 0
            ? overflow > 0
                ? `${names.join(", ")} (${overflow} more, see agents.list)`
                : names.join(", ")
            : "(none configured)";
    const SUBAGENT_TYPE_HINTS = buildTypeHints(displayTypes);

    const agentSchema = Type.Object({
        subagent_type: Type.String({
            description: `Which agent type to delegate to. Available types: ${typeList}.${SUBAGENT_TYPE_HINTS}`,
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
                    "the detail. Use this only when the result does not affect your next few steps: " +
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
        // The trailing prose starts on its own line: hint bullets are newline-led,
        // so joining directly would run the last bullet into this sentence.
        description: `Delegate a task to a subagent that runs in its own session with a constrained toolset. Available types: ${typeList}.${SUBAGENT_TYPE_HINTS}\nThe subagent returns a text result when done. Safe to issue multiple \`agent\` calls in the same turn — each runs in its own session and they execute concurrently. Pass \`background: true\` to launch a long-running subagent without waiting — its result arrives later as a message in this conversation instead of in this tool's result.`,
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
            const { subSessionId, resultText, isError, background } = await ctx.spawn({
                parentToolCallId: toolCallId,
                agentType: params.subagent_type,
                prompt: params.prompt,
                context: params.context,
                background: params.background,
                signal,
                onUpdate,
            });
            if (background) {
                // subSessionId is always present here — a background spawn
                // that failed before the child existed reports isError instead
                // (unknown agentType, concurrency limit) and background=false.
                const text = isError
                    ? `failed to launch background subagent: ${resultText}`
                    : `Subagent ${params.subagent_type} launched in background as session ${subSessionId}. ` +
                      "Its result will arrive as a message in this conversation once it finishes — do NOT " +
                      "spawn it again or poll for it. Continue with other work now.";
                return {
                    content: [{ type: "text", text }],
                    details: subSessionId
                        ? { status: "launched", subSessionId, agentType: params.subagent_type }
                        : { status: "completed", agentType: params.subagent_type },
                };
            }
            const text = isError ? `subagent error: ${resultText}` : resultText;
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
