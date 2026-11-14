import { Type } from "typebox";

export const chatSchema = Type.Object(
    {
        subSessionId: Type.String(),
        prompt: Type.String(),
        delivery: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
        background: Type.Optional(Type.Boolean()),
        inReplyTo: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export const listSchema = Type.Object({}, { additionalProperties: false });

/** Callbacks capture the caller's identity and workspace; tool arguments cannot override them. */
export interface AgentCommunicationTools {
    readonly allowedNames?: readonly ("chatToAgent" | "listAgentSessions")[];
    chat(args: {
        subSessionId: string;
        prompt: string;
        delivery?: "steer" | "followUp";
        background?: boolean;
        inReplyTo?: string;
    }): Promise<unknown>;
    list(): Promise<unknown>;
}

export const communicationDefinitions = [
    {
        name: "chatToAgent",
        description:
            "Message an existing agent with the same parent, never yourself. " +
            "A queued or started receipt confirms acceptance, not completion; consult status and effectiveDelivery. " +
            "Claude Code uses nextTurn delivery; Codex queues in Taco until the current turn settles. " +
            "Claude Code does not interrupt an active tool; Codex also waits rather than interrupting. " +
            "Agents have independent context; later parent conversation messages are not synced, so send needed context explicitly.",
        inputSchema: chatSchema,
    },
    {
        name: "listAgentSessions",
        description:
            "List other existing agent instances with the same parent, never yourself, with status and delivery capability. " +
            "Use chatToAgent to send context explicitly. Claude Code uses nextTurn and does not interrupt an active tool; " +
            "Codex queues until the current turn settles.",
        inputSchema: listSchema,
    },
] as const;
