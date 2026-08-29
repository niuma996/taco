/**
 * Pure UiMessage[] → UiMessage[] transforms used by workspacesReducer.
 *
 * These are the reducer's non-trivial work: everything else in a case is a
 * guard plus a shallow merge. Keeping them here lets each be tested against a
 * plain message array instead of a full workspace map, and keeps the reducer
 * readable as a dispatch table.
 *
 * Every function returns the input array reference unchanged when it has no
 * work to do — the reducer relies on that identity to skip re-renders.
 */

import type { AgentMessage, CommandPermissionRequest } from "@taco-ai/protocol";
import { extractAssistantTextAndThinking, type UiMessage } from "./chatUtils";

type AssistantMessage = Extract<UiMessage, { kind: "assistant" }>;
type AssistantTool = AssistantMessage["tools"][number];

/** Replace the tool at `toolId` inside whichever assistant message holds it.
 *  Scans from the end: tool cards are almost always in the newest bubble.
 *  Returns the original array when no message owns the id. */
function patchToolById(
    messages: UiMessage[],
    toolId: string,
    patch: (tool: AssistantTool) => AssistantTool,
): UiMessage[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.kind !== "assistant") continue;
        const toolIndex = message.tools.findIndex((tool) => tool.id === toolId);
        if (toolIndex < 0) continue;
        const tool = message.tools[toolIndex];
        if (!tool) continue;
        const tools = [...message.tools];
        tools[toolIndex] = patch(tool);
        const next = messages.slice();
        next[i] = { ...message, tools };
        return next;
    }
    return messages;
}

/** Merge extra fields into a tool card's `details` object. */
function mergeToolDetails(tool: AssistantTool, extra: Record<string, unknown>): AssistantTool {
    return { ...tool, details: { ...((tool.details ?? {}) as Record<string, unknown>), ...extra } };
}

/**
 * Expire shell tools left "running" when the sidecar process was replaced.
 * Only shell is expired: askUser / planExit recover from history, agent
 * subagents recover via snapshot, and other tools are out of scope.
 */
export function markRunningShellToolsFailed(messages: UiMessage[]): UiMessage[] {
    let changed = false;
    const next = messages.map((message) => {
        if (message.kind !== "assistant") return message;
        let toolChanged = false;
        const tools = message.tools.map((tool) => {
            if (tool.name !== "shell" || tool.status !== "running") return tool;
            toolChanged = true;
            return {
                ...tool,
                status: "error" as const,
                details: {
                    ...((tool.details ?? {}) as object),
                    reason: "sidecar_restarted",
                    exitCode: -1,
                    interrupted: false,
                },
            };
        });
        if (!toolChanged) return message;
        changed = true;
        return { ...message, tools };
    });
    return changed ? next : messages;
}

/** Attach an incoming permission request to the tool card that triggered it. */
export function attachCommandPermission(
    messages: UiMessage[],
    request: CommandPermissionRequest,
): UiMessage[] {
    const toolId = request.displayToolCallId ?? request.toolCallId;
    return patchToolById(messages, toolId, (tool) =>
        mergeToolDetails(tool, { commandPermission: request }),
    );
}

/**
 * Backfill the agent card's `details.subSessionId` so the expanded view can
 * bind the live child stream while the subagent is still running. `details`
 * normally only arrives on tool_execution_end — until then the card renders
 * "spawning…" even though the child stream is already accumulating.
 */
export function backfillSubagentDetails(
    messages: UiMessage[],
    parentToolCallId: string,
    subSessionId: string,
    agentType: string,
): UiMessage[] {
    return patchToolById(messages, parentToolCallId, (tool) =>
        mergeToolDetails(tool, {
            subSessionId,
            ...(agentType ? { agentType } : {}),
        }),
    );
}

/** Echo the user's askUser / planExit selection onto the tool card. */
export function attachAskUserAnswers(
    messages: UiMessage[],
    toolCallId: string,
    answers: Record<string, string | string[]>,
): UiMessage[] {
    return patchToolById(messages, toolCallId, (tool) => mergeToolDetails(tool, { answers }));
}

/**
 * Fold the final assistant message returned synchronously by sessionCreate /
 * sessionPrompt into the message list. When message_start already created a
 * same-timestamp live bubble, overwrite it in place; otherwise append. An
 * `stopReason === "error"` reply also appends a system bubble carrying
 * errorMessage — without it an immediate LLM error rendered an empty bubble.
 */
export function mergeAssistantFinal(messages: UiMessage[], reply: AgentMessage): UiMessage[] {
    const m = reply as AgentMessage & { stopReason?: string; errorMessage?: string };
    const { text, thinking } = extractAssistantTextAndThinking(m);
    const errorText = m.stopReason === "error" ? (m.errorMessage ?? "Assistant error") : null;
    const ts = String((m as { timestamp?: unknown }).timestamp ?? Date.now());
    const id = `final-asst-${ts}`;
    const next: UiMessage[] = [...messages];
    const liveIdx = next.findIndex((x) => x.kind === "assistant" && x.id === `live-asst-${ts}`);
    if (liveIdx >= 0) {
        // Shallow-clone before overwriting — the element shares its reference
        // with the input array, so direct assignment would pollute reducer input.
        const live = next[liveIdx] as AssistantMessage;
        next[liveIdx] = { ...live, text, thinking };
    } else {
        next.push({ id, kind: "assistant", text, ts: Date.now(), tools: [], thinking });
    }
    if (errorText) {
        next.push({ id: `${id}-err`, kind: "system", text: `⚠ ${errorText}`, ts: Date.now() });
    }
    return next;
}
