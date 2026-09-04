/**
 * Plan mode context hook — injects a planning directive while plan mode is active.
 *
 * The directive reminds the model that it is in read-only planning mode and
 * should delegate codebase exploration to the `explorer` subagent. The hook
 * is suppressed once planExit clears `planState.active`.
 */

import type { ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import type { PlanModeState } from "../tools/planModeState.ts";
import { createUserMessage, tagWrap } from "./builder.ts";

const PLAN_MODE_BODY = `You are in PLAN MODE. Do not write, edit, or modify any project files. Your only outputs are:
- Reading files
- Calling the explorer subagent to explore the codebase
- Writing the plan document at .taco/plans/<slug>.md
- Calling AskUser when requirements are ambiguous

## Planning Process

1. **Understand Requirements**: Restate the goal and identify constraints.

2. **Explore with explorer**: Spawn an explorer subagent to search and trace code. Give it focused, concrete exploration tasks, e.g.:
   - "Find all files that reference X"
   - "Trace how Y is initialized and used"
   - "List the public API surface of Z"

3. **Design the Solution**: Based on explorer's findings, choose an approach that follows existing patterns in the codebase.

4. **Write the Plan Document**: Produce a structured plan at .taco/plans/<slug>.md with:
   - Summary of the goal
   - Key findings from exploration
   - Step-by-step implementation strategy
   - Dependencies and sequencing
   - Risks / open questions
   - For complex architecture or multi-step flows, a \`\`\`mermaid fenced block diagramming it (the plan viewer renders these) — \`flowchart\` for architecture/data flow, \`sequenceDiagram\` for request/response or ordering between components
   - ### Critical Files for Implementation (3-5 files)

5. **Exit**: Call planExit to present the plan for user approval.

REMEMBER: You CANNOT modify project files in plan mode. Use explorer for exploration.`;

export function buildPlanModeContextHook(
    getPlanState: () => PlanModeState,
): (event: ContextEvent) => ContextResult | undefined {
    return (event: ContextEvent): ContextResult | undefined => {
        const state = getPlanState();
        if (!state.active || !state.currentSlug) return undefined;
        const body = `slug="${state.currentSlug}"\n${PLAN_MODE_BODY}`;
        event.messages.unshift(createUserMessage(tagWrap("plan_mode", body)));
        return { messages: event.messages };
    };
}
