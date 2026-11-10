/** Wire projection of a source lane watch, without a second runtime cache. */
import type { SessionRuntimeSnapshot } from "@taco-ai/protocol";
import { viewUserContent } from "../../attachments/userMessageView.ts";
import { redactUnknown } from "../../extensions/builtin/outputRedaction/index.ts";
import type { AttachedSession } from "./attachedSession.ts";

type LaneSnapshot = Awaited<ReturnType<AttachedSession["watchSnapshot"]>>["snapshot"];

/** User input resumes a terminating question even when its visible text is empty. */
function pendingQuestionIds(snapshot: LaneSnapshot): string[] {
    const pending = new Set<string>();
    for (const entry of snapshot.transcript) {
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (message.role === "user" || message.role === "assistant") pending.clear();
        if (
            message.role !== "toolResult" ||
            (message.toolName !== "askUser" && message.toolName !== "planExit")
        )
            continue;
        const details = message.details as { waiting?: unknown } | undefined;
        if (details?.waiting === true) pending.add(message.toolCallId);
        else pending.delete(message.toolCallId);
    }
    return [...pending];
}

export function toSessionRuntimeSnapshot(
    snapshot: LaneSnapshot,
    related: Pick<
        SessionRuntimeSnapshot,
        "pendingCommandPermissions" | "inFlightAgentToolCallIds" | "settledBackgroundSubSessionIds"
    >,
): SessionRuntimeSnapshot {
    const operation = snapshot.operation;
    const runtime: SessionRuntimeSnapshot = {
        operation: operation
            ? {
                  id: operation.id,
                  kind: operation.kind,
                  startedAt: operation.startedAt,
                  status: operation.status,
                  ...(operation.retry ? { retry: operation.retry } : {}),
              }
            : null,
        ...(operation?.streamingMessage ? { partialMessage: operation.streamingMessage } : {}),
        tools: (operation?.runningTools ?? []).map((tool) => ({
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            args: tool.args,
            status: tool.status,
            ...(tool.result
                ? { result: { content: tool.result.content, details: tool.result.details } }
                : {}),
            ...(tool.status === "settled" ? { isError: tool.isError } : {}),
        })),
        queues: snapshot.queues.map((entry) => {
            if (entry.type !== "message") return { entryId: entry.entryId, kind: entry.kind };
            const message = entry.message;
            if (message.role === "user") {
                const visible = viewUserContent(message.content);
                return {
                    entryId: entry.entryId,
                    kind: entry.kind,
                    message: { ...message, content: visible.content },
                };
            }
            return {
                entryId: entry.entryId,
                kind: entry.kind,
                ...(message.role === "assistant" || message.role === "toolResult"
                    ? { message }
                    : {}),
            };
        }),
        ...related,
        pendingAskUserToolCallIds: pendingQuestionIds(snapshot),
    };
    // Use the same redaction policy as live tool/permission pushes. Source
    // snapshots contain arguments and partial tool output before final hooks.
    return redactUnknown(runtime)[0] as SessionRuntimeSnapshot;
}
