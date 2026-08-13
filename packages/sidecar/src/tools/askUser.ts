/**
 * askUser tool — present questions to the user and block until they pick.
 * Answers are injected back as a user message on the next turn.
 *
 *  - First call: returns terminate=true, details.waiting=true. Frontend
 *    renders the question UI.
 *  - Second call: detects params.answers populated, returns answer text.
 */

import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AskUserParams, AskUserQuestion, AskUserToolDetails } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";

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
            "Present one or more questions to the user and block until they answer. Use this when proceeding would require guessing on a decision the user likely has a preference on — in particular: (1) multiple valid approaches exist that aren't equivalent (architecture, library, a naming scheme the user must live with); (2) the action is destructive or hard to reverse; (3) the request is genuinely ambiguous about intent or scope. Skip it for choices with an obvious default or that you can verify from the code — pick a reasonable option, note it, and continue. You may ask several questions in one call, but each must target a distinct topic — never split one topic across multiple questions.",
        parameters: askUserSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Block the current turn to ask the user a structured question (multi-choice or free-form). Use only when the answer genuinely requires the user — model-inferable facts should not be asked.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: AskUserToolInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
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
