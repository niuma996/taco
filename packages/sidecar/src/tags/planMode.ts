/**
 * Plan mode context hook — injects a planning directive while plan mode is active.
 *
 * The directive reminds the model that it is in read-only planning mode and
 * may delegate focused exploration when it helps. The hook
 * is suppressed once planExit clears `planState.active`.
 */

import type { ContextEvent, ContextResult } from "../extensions/types.ts";
import type { PlanModeState } from "../plan/planModeState.ts";
import { appendUserTag } from "./appendUserTag.ts";
import { tagWrap } from "./builder.ts";

const PLAN_MODE_BODY = `You are in PLAN MODE. Keep project files unchanged except for the plan document at .taco/plans/<slug>.md. You may:
- Inspect relevant code with the available read-only tools
- Delegate focused read-only exploration to an available explorer subagent when it helps
- Write or revise the plan document at .taco/plans/<slug>.md
- When the user asks for the plan to be saved somewhere else (a repository document, a named path), write it there as well — that write is put to the user for approval
- Resolve required user decisions using the question mechanism available in this session
- Call planExit when the plan is ready for approval

## Planning Process

1. **Understand Requirements**: Use the conversation to identify the requested outcome and constraints. Carry established findings forward; ask only about material unresolved requirements.

2. **Explore Proportionally**: Inspect enough code to produce an implementable plan. Handle small lookups directly. Delegate independent searches or traces only when an explorer is available and delegation is worthwhile. Reuse findings instead of restarting completed searches.

3. **Design the Solution**: Use the findings to choose an approach that follows existing patterns in the codebase.

4. **Write the Plan Document**: Produce a structured plan at .taco/plans/<slug>.md with:
   - Summary of the goal
   - Key findings from exploration
   - Step-by-step implementation strategy
   - Dependencies and sequencing
   - Risks / open questions
   - Critical files for implementation, limited to those actually relevant

5. **Exit**: Once the plan is implementable and required decisions are resolved, call planExit to present it for user approval. Investigate further only to resolve a concrete gap that blocks the plan.

Do not implement the plan before approval. The plan document is the one file you may write without asking; any other write is shown to the user for approval, so only propose paths the user actually named.`;

export function buildPlanModeContextHook(
    getPlanState: () => PlanModeState,
): (event: ContextEvent) => ContextResult | undefined {
    return (event: ContextEvent): ContextResult | undefined => {
        const state = getPlanState();
        if (!state.active || !state.currentSlug) return undefined;
        const body = PLAN_MODE_BODY;
        appendUserTag(
            event.messages,
            tagWrap("plan_mode", body, { slug: state.currentSlug }),
            "system-event",
        );
        return { messages: event.messages };
    };
}
