/**
 * planExit tool view — reuses AskUserToolView to render the same card.
 *
 * `tool.details.questions` is written by `applyEventToMessages` from
 * `tool_execution_end.details.questions`. The reducer treats planExit as an
 * askUser trigger, so `ASKUSER_ANSWERED` clears pending and injects answers.
 */

import { AskUserToolView } from "./askUserView";
import { type ToolViewProps, toolViews } from "./registry";

export function PlanExitToolView(props: ToolViewProps) {
    return <AskUserToolView {...props} />;
}

toolViews.planExit = PlanExitToolView;
