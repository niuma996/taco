/**
 * Session message DTOs — protocol-native, zero external type/runtime dependency.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
    timestamp: number;
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
    stopReason?: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
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
