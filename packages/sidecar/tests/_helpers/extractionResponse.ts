import type { AssistantMessage } from "../../src/runtime/pi/types.ts";

export function extractionResponse(actions: unknown): AssistantMessage {
    return {
        role: "assistant",
        stopReason: "toolUse",
        content: [
            {
                type: "toolCall",
                id: "extraction-result",
                name: "submit_memory_extraction",
                arguments: { actions },
            },
        ],
    } as unknown as AssistantMessage;
}
