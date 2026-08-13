import { randomBytes } from "node:crypto";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { PlanSnapshotPublisher } from "../plan/planPushAdapter.ts";
import { enterPlanMode, isPlanModeActive, type PlanModeState } from "./planModeState.ts";
import { getPlanPath, getPlansDir } from "./planPersistence.ts";

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
            "ambiguity about scope. In plan mode you may only read files, call AskUser, and write to " +
            ".taco/plans/<slug>.md. While in plan mode a planning directive is injected into every " +
            "context reminding you to delegate codebase exploration to the explorer subagent. You MUST " +
            "NOT modify project files. When your plan is ready, call planExit to present it for user " +
            "approval. Do NOT call planEnter for trivial tasks — one-line fixes, simple questions, or " +
            "changes the user has already fully specified.",
        parameters: planEnterSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Enter plan mode for non-trivial work. While active, only reading files, AskUser, and writing to `.taco/plans/<slug>.md` are allowed. Exit with `planExit` to request approval.",
            mutates: false,
        },
        async execute(
            _toolCallId: string,
            _params: PlanEnterInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
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
                        text: `Entered plan mode: **${slug}**\n\nPlan path: ${planPath}\n\nIn this mode you may only read files (text and images), call AskUser, and write the plan document at ${planPath}. A planning directive will be injected into every context to guide you through exploration, design, and writing the plan.`,
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
