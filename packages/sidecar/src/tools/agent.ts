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
    });

    type AgentToolInput = Static<typeof agentSchema>;

    return {
        name: "agent",
        label: "agent",
        // The trailing prose starts on its own line: hint bullets are newline-led,
        // so joining directly would run the last bullet into this sentence.
        description: `Delegate a task to a subagent that runs in its own session with a constrained toolset. Available types: ${typeList}.${SUBAGENT_TYPE_HINTS}\nThe subagent returns a text result when done. Safe to issue multiple \`agent\` calls in the same turn — each runs in its own session and they execute concurrently.`,
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
                context: params.context,
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
