import type { SessionId } from "@taco-ai/protocol";
import { findActiveListId } from "../tasks/activeList.ts";
import { sessionTasksDir } from "../tasks/sessionTasksDir.ts";
import { loadAllTaskLists } from "../tasks/taskPersistence.ts";
import { createTaskStore } from "../tasks/taskStore.ts";
import type { TaskStore } from "../tasks/taskTypes.ts";
import { createPlanModeState, type PlanModeState } from "../tools/planModeState.ts";

export interface SessionTaskState {
    taskStore: TaskStore;
    planState: PlanModeState;
    tasksDir: string;
}

/**
 * Build independent task/plan state for a session, hydrated from the session's
 * on-disk task list. Called once per session (on attach); sessions do not share state.
 */
export async function buildSessionTaskState(
    sessionId: SessionId,
    sessionsRoot: string,
): Promise<SessionTaskState> {
    const taskStore = createTaskStore(sessionId);
    const planState = createPlanModeState();
    const tasksDir = sessionTasksDir(sessionId, sessionsRoot);
    const lists = await loadAllTaskLists(tasksDir);
    for (const list of lists) {
        taskStore.lists.set(list.id, list);
    }
    // Restore active pointer: most-recent list with incomplete tasks; null if all are done (all move to history).
    taskStore.currentListId = findActiveListId(taskStore);
    return { taskStore, planState, tasksDir };
}
