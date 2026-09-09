/**
 * Consume the TASK_PANEL_FORCE_EXPAND flag for one cwd: open the task panel
 * and dispatch CONSUMED so the flag clears in the reducer. Extracted from
 * App.tsx so the wiring can be unit-tested without rendering App.
 *
 * The flag itself is set by useWorkspaces on the FIRST task snapshot for a
 * sid (gate: `prev.taskSnapshotsBySessionId[sid] === undefined`). After
 * CONSUMED clears it, subsequent TASKS_UPDATED for the same sid do not
 * re-set the flag, so re-calling this helper with the same cwd becomes a
 * no-op on the next reactive cycle.
 */
import type { WorkspaceAction, WorkspaceId } from "./workspaceReducer";

export interface ConsumeForceExpandArgs {
    forceExpandTaskPanel: boolean;
    activeCwd: WorkspaceId | null;
    showTaskPanel: () => void;
    dispatchWs: (action: WorkspaceAction) => void;
}

export function consumeForceExpandFlag(args: ConsumeForceExpandArgs): void {
    if (!args.forceExpandTaskPanel || !args.activeCwd) return;
    args.showTaskPanel();
    args.dispatchWs({ type: "TASK_PANEL_FORCE_EXPAND_CONSUMED", cwd: args.activeCwd });
}
