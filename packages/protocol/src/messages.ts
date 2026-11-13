/**
 * Session message DTOs — protocol-native, zero external type/runtime dependency.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Auxiliary calls are short and bounded; only the low levels are meaningful. */
export const LITE_THINKING_LEVELS = ["off", "minimal", "low"] as const;
export type LiteThinkingLevel = (typeof LITE_THINKING_LEVELS)[number];

export interface TextBlock {
    type: "text";
    text: string;
    textSignature?: string;
}
export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    redacted?: boolean;
}
export interface ImageBlock {
    type: "image";
    data: string;
    mimeType: string;
}
export interface ToolCallBlock {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
}
export type ProtocolContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
    role: "user";
    content: string | ProtocolContentBlock[];
    /** Structured source metadata for collaboration messages shown in a child session. */
    agentProvenance?: AgentMessageProvenance;
    timestamp: number;
}
export interface AgentMessageProvenance {
    messageId?: string;
    senderSessionId?: string;
    relation: "parent" | "peer";
}
export interface AssistantMessage {
    role: "assistant";
    content: ProtocolContentBlock[];
    api?: unknown;
    provider?: string;
    model?: string;
    responseModel?: string;
    responseId?: string;
    usage?: Usage;
    /** Mirrors pi's `StopReason` union. `"deferred"` means the provider returned
     *  a durable handle and is still working; the desktop renders it like any
     *  other non-error reason. Kept in sync with pi so the sidecar can hand its
     *  messages to the wire without a structural cast. */
    stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
    errorMessage?: string;
    rawStopReason?: string;
    timestamp: number;
}
export interface ToolResultMessage {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: ProtocolContentBlock[];
    details?: unknown;
    usage?: Usage;
    addedToolNames?: string[];
    isError: boolean;
    timestamp: number;
}
export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;
