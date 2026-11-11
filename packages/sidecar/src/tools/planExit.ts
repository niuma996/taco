import { readFileSync } from "node:fs";
import type { AskUserQuestion } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { isPlanModeActive, type PlanModeState } from "../plan/planModeState.ts";
import { getPlanPath, getPlansDir } from "../plan/planPersistence.ts";
import type { AgentHarnessTool, ExecutionToolContext, TextContent } from "../runtime/pi/types.ts";
import { askUserAnswersSchema } from "./askUser.ts";

/** Approval question shown on the desktop; the server matches these labels. */
export const PLAN_APPROVAL_QUESTION = "Approve this plan?";
export const PLAN_APPROVAL_LABEL = "Approve";

/**
 * planExit parameter schema:
 *  - First call: {planSlug?}
 *  - Second call (user has answered): {answers}
 *
 * planSlug is Optional — on the second call the LLM may drop the field, so we
 * fall back to state.currentSlug (set during planEnter).
 */
const planExitSchema = Type.Object({
    planSlug: Type.Optional(
        Type.String({
            minLength: 1,
            description: "Slug of the plan document to exit (without .md).",
        }),
    ),
    answers: askUserAnswersSchema,
});

export type PlanExitInput = Static<typeof planExitSchema>;

export interface PlanExitToolDetails {
    questions?: AskUserQuestion[];
    planContent: string;
    approved?: boolean;
    waiting?: boolean;
}

/** First call: show plan + return question, ask for user approval. */
function buildApprovalQuestion(planSlug: string, planContent: string) {
    const preview = planContent.slice(0, 600);
    const truncated = planContent.length > 600;
    return {
        text: `**Plan: \`${planSlug}\`**\n\n${preview}${truncated ? "\n..." : ""}\n\nPlease review this plan. If approved, exit plan mode. If rejected, you may update the .md plan file.`,
        questions: [
            {
                question: PLAN_APPROVAL_QUESTION,
                header: "planExit",
                options: [
                    {
                        label: PLAN_APPROVAL_LABEL,
                        description: "Approve the plan, exit plan mode, and start implementation.",
                    },
                    {
                        label: "Reject",
                        description: "Reject the plan and stay in plan mode.",
                    },
                ],
                multiSelect: false,
            },
        ] satisfies AskUserQuestion[],
    };
}

export function createPlanExitTool(
    state: PlanModeState,
    projectDir: string,
): AgentHarnessTool<ExecutionToolContext> {
    return {
        name: "planExit",
        label: "planExit",
        description:
            "Exit Plan mode and present the plan document to the user for approval. " +
            "Your plan document has been written and stored at .taco/plans/<slug>.md. " +
            "First call: pass {planSlug} (optional — defaults to the slug from planEnter). " +
            "Second call (user has answered): pass {answers}; planSlug may be omitted.",
        parameters: planExitSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Leave plan mode and present the saved plan for user approval. Reads back the `.taco/plans/<slug>.md` you wrote while in plan mode.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            params: PlanExitInput,
            _onUpdate: unknown,
        ): Promise<{
            content: TextContent[];
            details: PlanExitToolDetails;
            terminate?: boolean;
        }> {
            const answers = params.answers;
            const answered = answers !== undefined && Object.keys(answers).length > 0;

            if (!isPlanModeActive(state)) {
                // The approval decision is made by the server
                // (`session.submitAnswers`), the only channel that can prove a
                // person answered. By the time the model re-invokes this tool
                // with the submitted answers, plan mode is already off. A
                // fresh call without answers is still a misuse.
                if (!answered) {
                    throw new Error("Not in plan mode. Use planEnter first to enter plan mode.");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: "Plan approved. Exited plan mode.\n\nNext: use taskCreate to break this plan into an executable task list; when the user says 'continue', work through the list, calling taskUpdate on each as you finish.",
                        },
                    ],
                    details: { planContent: "", approved: true },
                };
            }

            if (answered) {
                // Still in plan mode: the user did not approve. Either they
                // rejected, or the model supplied `answers` on its own — the
                // server is the only path that exits plan mode, so a
                // fabricated answer changes nothing.
                return {
                    content: [
                        {
                            type: "text",
                            text: "Plan rejected. Stayed in plan mode — you may revise the plan document and call planExit again.",
                        },
                    ],
                    details: { planContent: "", approved: false },
                };
            }

            // First call: present the plan and ask for approval.
            // slug prefers params.planSlug; falls back to state.currentSlug (from planEnter).
            const slug = params.planSlug ?? state.currentSlug;
            if (!slug) {
                throw new Error("planSlug is required to exit plan mode.");
            }
            const plansDir = getPlansDir(projectDir);
            const planPath = getPlanPath(plansDir, slug);

            let planContent: string;
            try {
                planContent = readFileSync(planPath, "utf-8");
            } catch (_error) {
                throw new Error(
                    `Plan document not found: ${planPath}. You must write the plan document to this path before exiting plan mode.`,
                );
            }

            const { text, questions } = buildApprovalQuestion(slug, planContent);
            return {
                content: [{ type: "text", text }],
                details: {
                    questions,
                    planContent,
                    waiting: true,
                },
                terminate: true,
            };
        },
    };
}
