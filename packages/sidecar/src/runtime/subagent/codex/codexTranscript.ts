/**
 * Translate Codex SDK thread events into pi `AgentMessage`s. Only completed
 * items are persisted; started/updated frames drive live progress elsewhere.
 */

import type { AgentMessage } from "../../pi/types.ts";
import { neutralizeControlTags } from "../subagentProgress.ts";
import type { CodexThreadEvent, CodexThreadItem } from "./codexSdk.ts";

const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type AssistantDraft = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultDraft = Extract<AgentMessage, { role: "toolResult" }>;

function scrub(text: string): string {
    return neutralizeControlTags(text).text;
}

function assistant(content: AssistantDraft["content"]): AssistantDraft {
    const stopReason = content.some((entry) => entry.type === "toolCall") ? "toolUse" : "stop";
    return {
        role: "assistant",
        content,
        api: "codex",
        provider: "codex",
        model: "codex",
        usage: { ...ZERO_USAGE },
        stopReason,
        timestamp: Date.now(),
    };
}

function toolResult(id: string, name: string, text: string, isError = false): ToolResultDraft {
    return {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: scrub(text) }],
        isError,
        timestamp: Date.now(),
    };
}

/**
 * Stateful mapper. Unknown event/item variants are ignored so a newer SDK can
 * add output without breaking a running child.
 */
export class CodexTranscript {
    private lastText = "";

    get lastAssistantText(): string {
        return this.lastText;
    }

    push(event: CodexThreadEvent): AgentMessage[] {
        if (event.type !== "item.completed" || !event.item) return [];
        return this.pushItem(event.item);
    }

    flush(): AgentMessage[] {
        return [];
    }

    private pushItem(item: CodexThreadItem): AgentMessage[] {
        switch (item.type) {
            case "agent_message": {
                if (typeof item.text !== "string" || item.text.trim() === "") return [];
                const text = scrub(item.text);
                this.lastText = text;
                return [assistant([{ type: "text", text }])];
            }
            case "reasoning": {
                if (typeof item.text !== "string" || item.text.trim() === "") return [];
                return [assistant([{ type: "thinking", thinking: scrub(item.text) }])];
            }
            case "command_execution": {
                const command = typeof item.command === "string" ? item.command : "";
                const output =
                    typeof item.aggregated_output === "string" ? item.aggregated_output : "";
                const failed = item.status === "failed" || item.status === "in_progress";
                return [
                    assistant([
                        {
                            type: "toolCall",
                            id: item.id,
                            name: "command_execution",
                            arguments: { command },
                        },
                    ]),
                    toolResult(item.id, "command_execution", output, failed),
                ];
            }
            case "file_change": {
                const changes = Array.isArray(item.changes) ? item.changes : [];
                const text = changes
                    .map((change) => {
                        const row = change as { kind?: unknown; path?: unknown };
                        return `${String(row.kind ?? "update")}: ${String(row.path ?? "unknown")}`;
                    })
                    .join("\n");
                return [
                    assistant([
                        {
                            type: "toolCall",
                            id: item.id,
                            name: "file_change",
                            arguments: { changes },
                        },
                    ]),
                    toolResult(item.id, "file_change", text, item.status === "failed"),
                ];
            }
            case "mcp_tool_call": {
                const server = typeof item.server === "string" ? item.server : "mcp";
                const tool = typeof item.tool === "string" ? item.tool : "unknown";
                const name = `mcp__${server}__${tool}`;
                const result = item.result as
                    | { structured_content?: unknown; content?: Array<{ text?: unknown }> }
                    | undefined;
                const content = result?.content
                    ?.map((entry) => (typeof entry.text === "string" ? entry.text : ""))
                    .filter(Boolean)
                    .join("\n");
                const error = item.error as { message?: unknown } | undefined;
                return [
                    assistant([
                        {
                            type: "toolCall",
                            id: item.id,
                            name,
                            arguments: (item.arguments ?? {}) as Extract<
                                AssistantDraft["content"][number],
                                { type: "toolCall" }
                            >["arguments"],
                        },
                    ]),
                    toolResult(
                        item.id,
                        name,
                        content ?? JSON.stringify(result?.structured_content ?? ""),
                        typeof error?.message === "string",
                    ),
                ];
            }
            case "web_search": {
                const query = typeof item.query === "string" ? item.query : "";
                return [
                    assistant([
                        {
                            type: "toolCall",
                            id: item.id,
                            name: "web_search",
                            arguments: { query },
                        },
                    ]),
                    toolResult(item.id, "web_search", query),
                ];
            }
            case "error": {
                const message = typeof item.message === "string" ? item.message : "Codex error";
                return [assistant([{ type: "text", text: scrub(`[Codex error] ${message}`) }])];
            }
            default:
                return [];
        }
    }
}
