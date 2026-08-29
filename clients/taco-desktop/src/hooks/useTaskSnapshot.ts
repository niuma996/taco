import type { TasksUpdatedParams, WorkspaceId } from "@taco-ai/protocol";
import type { WorkspaceState } from "../lib/chat/workspaceReducer";

/**
 * Reads one workspace/session task snapshot from the App-owned reducer state.
 * Callers must pass `workspaces`; invoking useWorkspaces here would create an
 * independent reducer instance. Each session has an isolated snapshot.
 */
export function useTaskSnapshot(
    workspaces: Record<string, WorkspaceState>,
    cwd: WorkspaceId,
    sid: string,
): { active: TasksUpdatedParams["active"]; history: TasksUpdatedParams["history"] } {
    const ws: WorkspaceState | undefined = workspaces[cwd];
    if (!sid) return { active: null, history: [] };
    return ws?.taskSnapshotsBySessionId[sid] ?? { active: null, history: [] };
}
