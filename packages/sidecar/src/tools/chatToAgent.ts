import { asSessionId, type ChatToAgentToolDetails } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { AgentConversationContext } from "../agents/agentConversationTypes.ts";
import type { AgentHarnessToolUpdateCallback, Context, TextContent } from "../runtime/pi/types.ts";
import type { TacoToolContext } from "./context.ts";
import type { TacoTool } from "./index.ts";

const chatToAgentSchema = Type.Object({
    subSessionId: Type.String({
        description: "An existing session id from `agent` or `listAgentSessions`.",
    }),
    prompt: Type.String({ description: "The message to send to the existing agent conversation." }),
    delivery: Type.Optional(
        Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
            default: "steer",
            description:
                "steer requests input during a running conversation; followUp queues input after its current run. The receipt reports effectiveDelivery. Claude Code uses nextTurn delivery. Codex queues in Taco until the current turn settles.",
        }),
    ),
    background: Type.Optional(
        Type.Boolean({
            default: true,
            description:
                "Return a message receipt immediately by default. Synchronous background: false is supported only when a parent addresses its own idle child.",
        }),
    ),
    inReplyTo: Type.Optional(
        Type.String({ description: "The messageId this message replies to." }),
    ),
});

type ChatToAgentInput = Static<typeof chatToAgentSchema>;

export function createChatToAgentTool(ctx: AgentConversationContext): TacoTool {
    return {
        name: "chatToAgent",
        label: "chatToAgent",
        description:
            "Message an existing agent: interject while it is running or resume its conversation after it has settled. " +
            "Use `agent` to create a new agent and `listAgentSessions` to find communicable instances. " +
            "A parent can address its children; a child can address only other child agents with the same parent, never yourself. " +
            "Later parent conversation messages do not automatically sync to children; send needed context explicitly. " +
            "Defaults to delivery steer and background true. Synchronous background: false works only from a parent to its own idle child. " +
            "Claude Code delivers at nextTurn and does not interrupt an active tool. " +
            "Codex queues messages in Taco and applies them after the current turn, not mid-tool. " +
            "A queued or started receipt confirms acceptance, not completion; consult status and effectiveDelivery.",
        parameters: chatToAgentSchema,
        executionMode: "parallel",
        taco: {
            promptSummary:
                "Message a running or settled agent by subSessionId; use agent to create one and listAgentSessions to discover targets. Send new parent context explicitly. Defaults to a background receipt, which confirms acceptance rather than completion.",
            mutates: true,
        },
        async execute(
            toolCallId: string,
            params: ChatToAgentInput,
            onUpdate: AgentHarnessToolUpdateCallback<ChatToAgentToolDetails>,
            _context: TacoToolContext,
            _invocation: unknown,
            piContext: Context,
        ): Promise<{ content: TextContent[]; details: ChatToAgentToolDetails; isError?: boolean }> {
            const result = await ctx.chat({
                parentToolCallId: toolCallId,
                subSessionId: asSessionId(params.subSessionId),
                prompt: params.prompt,
                delivery: params.delivery ?? "steer",
                background: params.background ?? true,
                inReplyTo: params.inReplyTo,
                signal: piContext.abortSignal,
                onUpdate,
            });
            const details: ChatToAgentToolDetails = {
                subSessionId: result.subSessionId,
                messageId: result.messageId,
                status: result.status,
                effectiveDelivery: result.effectiveDelivery,
                ...(result.runId === undefined ? {} : { runId: result.runId }),
                ...(result.resultPath === undefined ? {} : { resultPath: result.resultPath }),
            };
            const isError =
                result.status !== "aborted" && (result.isError || result.status === "error");
            const heading = isError
                ? "Agent chat error."
                : result.status === "queued" || result.status === "started"
                  ? "Message accepted; this receipt is not completion."
                  : result.status === "aborted"
                    ? "Agent chat aborted."
                    : "Agent chat completed.";
            // Details are UI-only; the model needs the receipt identifiers in content too.
            const receipt = JSON.stringify(
                {
                    ...details,
                    runId: details.runId ?? null,
                    resultPath: details.resultPath ?? null,
                },
                null,
                2,
            );
            const text = [heading, receipt, result.resultText].filter(Boolean).join("\n\n");
            return {
                content: [{ type: "text", text }],
                details,
                ...(isError ? { isError: true } : {}),
            };
        },
    };
}
