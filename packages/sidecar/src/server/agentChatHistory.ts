import { asSessionId, type SessionHistory, type SessionId } from "@taco-ai/protocol";
import type { AgentMessageRecord } from "../runtime/subagent/agentConversation.ts";

/** The durable inbox knows outcomes that happened after the persisted tool receipt. */
export async function rehydrateAgentChatReceipts(
    history: SessionHistory,
    readMessages: (id: SessionId) => Promise<AgentMessageRecord[]>,
): Promise<SessionHistory> {
    const children = new Map<string, Promise<AgentMessageRecord[]>>();
    const entries = await Promise.all(
        history.entries.map(async (entry) => {
            const payload = entry.payload as
                | {
                      role?: string;
                      toolName?: string;
                      toolCallId?: string;
                      details?: { subSessionId?: string; messageId?: string };
                  }
                | undefined;
            if (payload?.role !== "toolResult" || payload.toolName !== "chatToAgent") return entry;
            const target = payload.details?.subSessionId;
            const messageId = payload.details?.messageId;
            if (typeof target !== "string" || typeof messageId !== "string") return entry;
            let pending = children.get(target);
            if (!pending) {
                pending = readMessages(asSessionId(target)).catch(() => []);
                children.set(target, pending);
            }
            const record = (await pending).find(
                (message) =>
                    message.messageId === messageId &&
                    message.senderSessionId === history.sessionId &&
                    message.invocationId ===
                        JSON.stringify([history.sessionId, payload.toolCallId]),
            );
            if (!record?.receipt) return entry;
            const { resultText, isError, ...details } = record.receipt;
            return {
                ...entry,
                payload: {
                    ...payload,
                    details,
                    isError: details.status !== "aborted" && isError,
                    ...(details.status === "error"
                        ? { content: [{ type: "text", text: resultText }] }
                        : {}),
                },
            };
        }),
    );
    return { ...history, entries };
}
