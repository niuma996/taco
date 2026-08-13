/**
 * askUser answer injection text — serialization + branch lookup.
 *
 * Server-side entry point for building the `<ask_user_context>...</ask_user_context>`
 * user message that `session.submitAnswers` uses to prompt answers back into
 * the session.
 */

import type { AskUserQuestion, AskUserToolDetails } from "@taco-ai/protocol";
import type { AttachedSession } from "../runtime/attachedSession.ts";

export function formatAskUserContextBody(
    toolName: string,
    questions: readonly AskUserQuestion[],
    answers: Record<string, string | string[]>,
): string {
    return [
        `The user has answered your ${toolName} questions.`,
        `Please call the ${toolName} tool again with the questions and answers below.`,
        "questions (JSON):",
        JSON.stringify(questions, null, 2),
        "answers (JSON):",
        JSON.stringify(answers, null, 2),
    ].join("\n");
}

export function wrapAskUserContext(body: string): string {
    return `<ask_user_context>\n${body}\n</ask_user_context>`;
}

/**
 * Find the questions from a waiting toolResult in the attached session's branch
 * entries. Used by `session.submitAnswers` to verify the toolCallId is still
 * in the waiting state.
 *
 * Match conditions: toolName match + toolCallId match + details.waiting.
 * Returns `details.questions` on hit, otherwise null. O(N) by design.
 */
export async function resolveAskUserQuestions(
    attached: AttachedSession,
    toolCallId: string,
    expectedToolName: string,
): Promise<AskUserQuestion[] | null> {
    const entries = await attached.session.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type !== "message") continue;
        const msg = entry.message as ToolResultMsgLike;
        if (msg.role !== "toolResult") continue;
        if (msg.toolCallId !== toolCallId) continue;
        if (msg.toolName !== expectedToolName) continue;
        const details = msg.details as AskUserToolDetails | undefined;
        if (details?.waiting !== true) continue;
        if (!details.questions) continue;
        return details.questions;
    }
    return null;
}

interface ToolResultMsgLike {
    role?: string;
    toolName?: string;
    toolCallId?: string;
    details?: unknown;
}
