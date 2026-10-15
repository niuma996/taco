/**
 * Translate a Claude Code SDK message stream into pi `AgentMessage`s, so a
 * Claude Code subagent's run lands in its child session as an ordinary
 * transcript and the desktop renders it with the generic tool cards.
 *
 * The SDK emits one `assistant` frame per content block; frames of the same
 * model reply share `message.id`, and are merged here into one message. Every
 * text the child produced is passed through `neutralizeControlTags` before it
 * is persisted: the parent reads this transcript back, and Claude Code output
 * is not bound by taco's prompts.
 */

import type { AgentMessage } from "../../pi/types.ts";
import { neutralizeControlTags } from "../subagentProgress.ts";
import type { SdkContentBlock, SdkMessage } from "./claudeCodeSdk.ts";

const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AssistantDraft = Extract<AgentMessage, { role: "assistant" }>;

function scrub(text: string): string {
    return neutralizeControlTags(text).text;
}

function toolResultText(content: SdkContentBlock["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}

/**
 * Stateful mapper: feed SDK frames in order with `push`, which returns the pi
 * messages that are complete and ready to append. `flush` returns whatever is
 * still open once the stream ends.
 */
export class ClaudeCodeTranscript {
    private open: { id: string; message: AssistantDraft } | undefined;
    /** toolCall id → tool name; the SDK's tool_result blocks carry only the id. */
    private readonly toolNames = new Map<string, string>();
    private lastText = "";

    /** Text of the most recent assistant reply that had any, already scrubbed. */
    get lastAssistantText(): string {
        return this.lastText;
    }

    push(frame: SdkMessage): AgentMessage[] {
        if (frame.type === "assistant") return this.pushAssistant(frame.message);
        if (frame.type === "user") return this.pushUser(frame.message.content);
        return [];
    }

    flush(): AgentMessage[] {
        return this.close();
    }

    private pushAssistant(message: Extract<SdkMessage, { type: "assistant" }>["message"]) {
        const done = this.open?.id === message.id ? [] : this.close();
        if (!this.open) {
            this.open = {
                id: message.id,
                message: {
                    role: "assistant",
                    content: [],
                    api: "claude-code",
                    provider: "claude-code",
                    model: message.model ?? "claude-code",
                    usage: { ...ZERO_USAGE },
                    stopReason: "stop",
                    timestamp: Date.now(),
                },
            };
        }
        const draft = this.open.message;
        for (const block of message.content) {
            if (block.type === "text" && typeof block.text === "string") {
                draft.content.push({ type: "text", text: scrub(block.text) });
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
                draft.content.push({ type: "thinking", thinking: scrub(block.thinking) });
            } else if (block.type === "tool_use" && block.id && block.name) {
                this.toolNames.set(block.id, block.name);
                draft.content.push({
                    type: "toolCall",
                    id: block.id,
                    name: block.name,
                    arguments: (block.input ?? {}) as Extract<
                        AssistantDraft["content"][number],
                        { type: "toolCall" }
                    >["arguments"],
                });
                draft.stopReason = "toolUse";
            }
        }
        return done;
    }

    private pushUser(content: string | SdkContentBlock[]): AgentMessage[] {
        const done = this.close();
        if (typeof content === "string") return done;
        for (const block of content) {
            if (block.type !== "tool_result" || !block.tool_use_id) continue;
            done.push({
                role: "toolResult",
                toolCallId: block.tool_use_id,
                toolName: this.toolNames.get(block.tool_use_id) ?? "unknown",
                content: [{ type: "text", text: scrub(toolResultText(block.content)) }],
                isError: block.is_error === true,
                timestamp: Date.now(),
            });
        }
        return done;
    }

    private close(): AgentMessage[] {
        if (!this.open) return [];
        const { message } = this.open;
        this.open = undefined;
        const text = message.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join("");
        if (text.trim() !== "") this.lastText = text;
        return [message];
    }
}
