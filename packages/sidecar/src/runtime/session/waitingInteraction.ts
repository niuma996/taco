import type { WorkWaitingSummary } from "@taco-ai/protocol";

export type WaitingInteraction = WorkWaitingSummary & { toolName: "askUser" | "planExit" };

/** Normalize a successful terminating interaction without treating ordinary tool output as a wait. */
export function resolveWaitingInteraction(
    reply: unknown,
    sessionId: string,
): WaitingInteraction | undefined {
    if (!reply || typeof reply !== "object") return undefined;
    const value = reply as {
        role?: unknown;
        isError?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        details?: unknown;
    };
    if (
        value.role !== "toolResult" ||
        value.isError === true ||
        typeof value.toolCallId !== "string" ||
        !value.toolCallId ||
        (value.toolName !== "askUser" && value.toolName !== "planExit")
    )
        return undefined;
    const details = value.details as { waiting?: unknown; questions?: unknown } | null | undefined;
    if (details?.waiting !== true) return undefined;
    const questions = Array.isArray(details.questions) ? details.questions : [];
    const description = questions
        .flatMap((question) =>
            typeof question?.question === "string" ? [question.question.trim()] : [],
        )
        .join("; ")
        .slice(0, 400);
    return {
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        sessionId,
        ...(description ? { description } : {}),
    };
}
