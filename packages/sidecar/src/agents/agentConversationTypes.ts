import type { AgentSessionDescriptor, ChatToAgentToolDetails, SessionId } from "@taco-ai/protocol";
import type { SubagentProgressSink } from "./types.ts";

export interface AgentChatArgs {
    parentToolCallId: string;
    subSessionId: SessionId;
    prompt: string;
    delivery?: "steer" | "followUp";
    background?: boolean;
    inReplyTo?: string;
    signal?: AbortSignal;
    onUpdate?: SubagentProgressSink;
}

export interface AgentChatResult extends ChatToAgentToolDetails {
    resultText: string;
    isError: boolean;
}

/** The session-scoped implementation enforces which targets the caller can reach. */
export interface AgentConversationContext {
    chat(args: AgentChatArgs): Promise<AgentChatResult>;
    list(): Promise<AgentSessionDescriptor[]>;
}
