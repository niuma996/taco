import type { AgentSessionDescriptor } from "@taco-ai/protocol";
import { Type } from "typebox";
import type { AgentConversationContext } from "../agents/agentConversationTypes.ts";
import type { TextContent } from "../runtime/pi/types.ts";
import type { TacoTool } from "./index.ts";

const MAX_SESSIONS = 100;
const MAX_DESCRIPTION_LENGTH = 500;

export function createListAgentSessionsTool(ctx: AgentConversationContext): TacoTool {
    return {
        name: "listAgentSessions",
        label: "listAgentSessions",
        description:
            "List existing agent session instances available to `chatToAgent`, with status, resumability, and delivery capability. " +
            "A parent sees its children; a child sees only other child agents with the same parent, never yourself. " +
            "This lists instances, not agent types; use `agent` to create a new agent. " +
            "Returns at most 100 descriptors with descriptions limited to 500 characters. " +
            "Claude Code uses nextTurn delivery and does not interrupt an active tool. Codex uses queued delivery after the current turn.",
        parameters: Type.Object({}, { additionalProperties: false }),
        executionMode: "parallel",
        taco: {
            promptSummary:
                "List other communicable agent instances and their status, resumability, and delivery capability before using chatToAgent. Read-only; use agent to create a new instance.",
            mutates: false,
        },
        async execute(): Promise<{
            content: TextContent[];
            details: { sessions: AgentSessionDescriptor[]; omitted?: number };
        }> {
            const instances = await ctx.list();
            // Project explicitly so future runtime fields cannot leak conversation history.
            const sessions = instances.slice(0, MAX_SESSIONS).map(
                (session): AgentSessionDescriptor => ({
                    subSessionId: session.subSessionId,
                    agentType: session.agentType,
                    ...(session.description === undefined
                        ? {}
                        : { description: session.description.slice(0, MAX_DESCRIPTION_LENGTH) }),
                    status: session.status,
                    canResume: session.canResume,
                    delivery: session.delivery,
                }),
            );
            const details = {
                sessions,
                ...(instances.length > MAX_SESSIONS
                    ? { omitted: instances.length - MAX_SESSIONS }
                    : {}),
            };
            const snapshot = JSON.stringify(details, null, 2);
            const text = sessions.length
                ? snapshot
                : `No other agents are available for communication.\n\n${snapshot}`;
            return { content: [{ type: "text", text }], details };
        },
    };
}
