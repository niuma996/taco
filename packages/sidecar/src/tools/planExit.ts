import { readFileSync } from "node:fs";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { AskUserQuestion, SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { PlanSnapshotPublisher } from "../plan/planPushAdapter.ts";
import { askUserAnswersSchema } from "./askUser.ts";
import { exitPlanMode, isPlanModeActive, type PlanModeState } from "./planModeState.ts";
import { getPlanPath, getPlansDir } from "./planPersistence.ts";

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
                question: "Approve this plan?",
                header: "planExit",
                options: [
                    {
                        label: "Approve",
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
    publisher: PlanSnapshotPublisher | undefined,
    sessionId: SessionId,
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
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            context: ExecutionToolContext,
        ): Promise<{
            content: TextContent[];
            details: PlanExitToolDetails;
            terminate?: boolean;
        }> {
            if (!isPlanModeActive(state)) {
                throw new Error("Not in plan mode. Use planEnter first to enter plan mode.");
            }

            // Second call: answers were forwarded by the frontend via
            // session.steer injecting <ask_user_context>. The model re-invokes
            // this tool with a non-empty `answers` field. We skip readFileSync
            // here — the user may have deleted the .md, but the Approve/Reject
            // decision should not be blocked by unrelated I/O.
            const answers = params.answers;
            if (answers && Object.keys(answers).length > 0) {
                const firstKey = Object.keys(answers)[0];
                const choice = answers[firstKey];
                const choiceLabel = Array.isArray(choice) ? choice[0] : choice;
                const approved = choiceLabel === "Approve";

                if (approved) {
                    exitPlanMode(state);
                    publisher?.publishPlanState(context.env.cwd as WorkspaceId, sessionId, {
                        active: false,
                        currentSlug: null,
                    });
                }
                // On reject, plan mode stays active so the model can revise the document and retry planExit.

                return {
                    content: [
                        {
                            type: "text",
                            text: approved
                                ? "Plan approved. Exited plan mode.\n\nNext: use taskCreate to break this plan into an executable task list; when the user says 'continue', work through the list, calling taskUpdate on each as you finish."
                                : "Plan rejected. Stayed in plan mode — you may revise the plan document and call planExit again.",
                        },
                    ],
                    details: {
                        planContent: "",
                        approved,
                    },
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
