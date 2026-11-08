/**
 * askUser tool — present questions to the user and block until they pick.
 * Answers are injected back as a user message on the next turn.
 *
 *  - First call: returns terminate=true, details.waiting=true. Frontend
 *    renders the question UI.
 *  - Second call: detects params.answers populated, returns answer text.
 */

import type { AskUserParams, AskUserQuestion, AskUserToolDetails } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext, TextContent } from "../runtime/pi/types.ts";

export type AskUserTool = AgentHarnessTool<ExecutionToolContext>;

const questionOptionSchema = Type.Object({
    label: Type.String({ description: "Short text shown as the selectable option label." }),
    description: Type.String({
        description: "One-sentence explanation of what this option means or does.",
    }),
    preview: Type.Optional(
        Type.String({
            description:
                "Optional richer preview (e.g. code snippet, diff, mockup) shown alongside the option.",
        }),
    ),
});

const questionSchema = Type.Object({
    question: Type.String({
        description: "The question to ask. Be specific: state what decision is needed and why.",
    }),
    header: Type.String({
        description: "Short label (≤12 chars) shown as a chip/tag above the question card.",
    }),
    options: Type.Array(questionOptionSchema, {
        description:
            "2–4 available choices. For single-select (multiSelect=false) they should be mutually exclusive; for multiSelect they should be independently combinable.",
    }),
    multiSelect: Type.Boolean({
        description:
            "Set true only when the choices can be combined (e.g. picking which features to enable). Default false — single-select — for mutually exclusive decisions where exactly one answer applies.",
    }),
});

/**
 * Shared answers schema — same shape as askUser's `answers` and planExit's
 * second-call `answers`. Single-select: label string. Multi-select: label
 * array (avoids CSV-joining ambiguity for labels containing commas).
 */
export const askUserAnswersSchema = Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])),
);

const askUserSchema = Type.Object({
    questions: Type.Array(questionSchema, {
        description:
            "One or more questions to present. Ask the minimum needed — each question blocks the turn until answered.",
    }),
    /**
     * Single-select: label string. Multi-select: label array. Use a union
     * instead of forcing string to avoid CSV-joining ambiguity for labels
     * containing commas.
     */
    answers: askUserAnswersSchema,
    annotations: Type.Optional(
        Type.Record(
            Type.String(),
            Type.Object({
                preview: Type.Optional(Type.String()),
                notes: Type.Optional(Type.String()),
            }),
        ),
    ),
    metadata: Type.Optional(
        Type.Object({
            source: Type.Optional(Type.String()),
        }),
    ),
});

export type AskUserToolInput = Static<typeof askUserSchema>;

function formatQuestionsAsText(questions: AskUserQuestion[]): string {
    return questions
        .map((q, i) => {
            const opts = q.options.map((o) => `  - ${o.label}: ${o.description}`).join("\n");
            return `[${i + 1}] ${q.question}\n${opts}`;
        })
        .join("\n\n");
}

function formatAnswersAsText(params: AskUserParams): string {
    const entries = Object.entries(params.answers ?? {});
    if (entries.length === 0) return "(no answers)";
    return entries
        .map(([question, answer]) => {
            const annotation = params.annotations?.[question];
            const parts = [`"${question}"="${answer}"`];
            if (annotation?.preview) parts.push(`selected preview:\n${annotation.preview}`);
            if (annotation?.notes) parts.push(`user notes: ${annotation.notes}`);
            return parts.join(" ");
        })
        .join(", ");
}

export function createAskUserTool(): AskUserTool {
    return {
        name: "askUser",
        label: "askUser",
        description:
            "Present structured questions in the desktop question picker and end the run until answers are submitted. This tool does not detect channel availability or fall back to a text question. In an IM session identified by <im_channel>, ask in your final assistant reply instead of calling this tool. Use for decisions the user must own: materially different approaches or preferences, destructive or hard-to-reverse actions requiring authorization, or genuine ambiguity about intent or scope that prevents useful progress. Reuse established preferences and authorization. Make routine reversible choices using the code, docs, and task context; uncertainty alone does not require a question. Each question must target a distinct topic.",
        parameters: askUserSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Ask a user-owned decision through the desktop picker and wait for submitted answers. In IM (<im_channel>), ask in your final assistant reply instead; this tool has no channel-unavailable fallback.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: AskUserToolInput,
            _onUpdate: unknown,
            _context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: AskUserToolDetails; terminate?: boolean }> {
            // User has answered: return answers directly without re-prompting.
            if (params.answers && Object.keys(params.answers).length > 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `User has answered your questions: ${formatAnswersAsText(params)}. You can now continue...`,
                        },
                    ],
                    details: { answers: params.answers, waiting: false },
                };
            }

            // First call: present questions and wait for the user to answer.
            return {
                content: [
                    {
                        type: "text",
                        text: `Please answer the following questions:\n\n${formatQuestionsAsText(params.questions)}`,
                    },
                ],
                details: { questions: params.questions, waiting: true },
                terminate: true,
            };
        },
    };
}
