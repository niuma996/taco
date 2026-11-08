import { randomBytes } from "node:crypto";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { enterPlanMode, isPlanModeActive, type PlanModeState } from "../plan/planModeState.ts";
import { getPlanPath, getPlansDir } from "../plan/planPersistence.ts";
import type { PlanSnapshotPublisher } from "../plan/planPushAdapter.ts";
import type { AgentHarnessTool, ExecutionToolContext, TextContent } from "../runtime/pi/types.ts";

const planEnterSchema = Type.Object({});

export type PlanEnterInput = Static<typeof planEnterSchema>;

export function createPlanEnterTool(
    state: PlanModeState,
    projectDir: string,
    publisher: PlanSnapshotPublisher | undefined,
    sessionId: SessionId,
): AgentHarnessTool<ExecutionToolContext> {
    return {
        name: "planEnter",
        label: "planEnter",
        description:
            "Enter plan mode. Use BEFORE you start writing code or making file changes when the task is " +
            "non-trivial: multi-file refactors, new features with design decisions, anything with " +
            "ambiguity about scope that requires user sign-off. In plan mode use available read-only tools, " +
            "resolve required user decisions, and write only to .taco/plans/<slug>.md. Delegate focused " +
            "read-only exploration only when an explorer is available and it helps complete the plan. " +
            "Do not implement project changes. When your plan is ready, call planExit to present it for user " +
            "approval. Do NOT call planEnter for trivial tasks — one-line fixes, simple questions, or " +
            "changes the user has already fully specified.",
        parameters: planEnterSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Enter plan mode when implementation needs user sign-off. Inspect relevant code with available read-only tools, resolve required decisions, and write only `.taco/plans/<slug>.md`. Exit with `planExit` when the plan is ready for approval.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            _params: PlanEnterInput,
            _onUpdate: unknown,
            context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: { slug: string; planPath: string } }> {
            if (isPlanModeActive(state)) {
                throw new Error("Already in plan mode. Exit plan mode before re-entering.");
            }

            const date = new Date().toISOString().split("T")[0];
            const hex = randomBytes(3).toString("hex");
            const slug = `${date}-${hex}`;

            enterPlanMode(state, slug);

            publisher?.publishPlanState(context.env.cwd as WorkspaceId, sessionId, {
                active: true,
                currentSlug: slug,
            });

            const plansDir = getPlansDir(projectDir);
            const planPath = getPlanPath(plansDir, slug);

            return {
                content: [
                    {
                        type: "text",
                        text: `Entered plan mode: **${slug}**\n\nPlan path: ${planPath}\n\nUse available read-only tools to inspect relevant code and resolve required user decisions. You may write only the plan document at ${planPath}. Delegate focused read-only exploration only when an explorer is available and it helps. Once the plan is implementable, call planExit for approval.`,
                    },
                ],
                details: {
                    slug,
                    planPath,
                },
            };
        },
    };
}
