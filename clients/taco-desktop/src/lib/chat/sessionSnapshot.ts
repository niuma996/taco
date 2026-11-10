import type { SessionSnapshot } from "@taco-ai/protocol";
import {
    extractAssistantTextAndThinking,
    historyToUiMessages,
    stringifyResult,
    toolResultIsError,
    type UiMessage,
    type UiToolCall,
} from "./chatUtils";

export function snapshotToUiMessages(snapshot: SessionSnapshot): UiMessage[] {
    const runtime = snapshot.runtime;
    const messages = historyToUiMessages(
        snapshot.history.entries,
        runtime
            ? {
                  inFlightAgentToolCallIds: [
                      ...runtime.inFlightAgentToolCallIds,
                      ...runtime.tools
                          .filter((t) => t.status === "running")
                          .map((t) => t.toolCallId),
                  ],
              }
            : undefined,
    );
    if (!runtime) return messages;
    const partial = runtime.partialMessage;
    if (partial?.role === "assistant") {
        const ts = Number(partial.timestamp ?? runtime.operation?.startedAt ?? 0);
        const existing = messages.findIndex((m) => m.kind === "assistant" && m.ts === ts);
        const { text } = extractAssistantTextAndThinking(partial);
        // Stream deltas address the source content index, including non-thinking blocks.
        const thinking: Extract<UiMessage, { kind: "assistant" }>["thinking"] = [];
        if (Array.isArray(partial.content)) {
            partial.content.forEach((block, index) => {
                if (block.type === "thinking")
                    thinking[index] = {
                        thinking: block.redacted ? "" : block.thinking,
                        startedAt: ts,
                        ...(block.redacted ? { redacted: true } : {}),
                    };
            });
        }
        const previous = existing >= 0 ? messages[existing] : undefined;
        const pendingTools = (Array.isArray(partial.content) ? partial.content : []).flatMap(
            (block) =>
                block.type === "toolCall"
                    ? [
                          {
                              id: block.id,
                              name: block.name,
                              args: block.arguments,
                              status: "running" as const,
                          },
                      ]
                    : [],
        );
        const tools = previous?.kind === "assistant" ? [...previous.tools] : [];
        for (const tool of pendingTools)
            if (!tools.some((old) => old.id === tool.id)) tools.push(tool);
        const bubble: UiMessage = {
            id: `live-asst-${partial.timestamp ?? ts}`,
            kind: "assistant",
            ts,
            text,
            thinking,
            tools,
        };
        if (existing >= 0) messages[existing] = bubble;
        else messages.push(bubble);
    }
    for (const tool of runtime.tools) {
        let index = messages.findIndex(
            (m) => m.kind === "assistant" && m.tools.some((t) => t.id === tool.toolCallId),
        );
        if (index < 0) {
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]?.kind === "assistant") {
                    index = i;
                    break;
                }
            }
        }
        if (index < 0) {
            messages.push({
                id: `operation-${runtime.operation?.id ?? tool.toolCallId}`,
                kind: "assistant",
                ts: runtime.operation?.startedAt ?? 0,
                text: "",
                thinking: [],
                tools: [],
            });
            index = messages.length - 1;
        }
        const assistant = messages[index];
        if (assistant?.kind !== "assistant") continue;
        const incoming: UiToolCall = {
            id: tool.toolCallId,
            name: tool.toolName,
            args: tool.args,
            status:
                tool.status === "running"
                    ? "running"
                    : toolResultIsError(tool.toolName, tool.isError, tool.result?.details)
                      ? "error"
                      : "ok",
            ...(tool.result
                ? { resultText: stringifyResult(tool.result), details: tool.result.details }
                : {}),
        };
        const tools = assistant.tools.filter((t) => t.id !== incoming.id);
        const original = assistant.tools.findIndex((t) => t.id === incoming.id);
        tools.splice(original < 0 ? tools.length : original, 0, incoming);
        messages[index] = { ...assistant, tools };
    }
    return messages;
}
