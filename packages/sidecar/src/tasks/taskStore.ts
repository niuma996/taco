import type { TaskList, TaskStore } from "./taskTypes.ts";

/**
 * Creates a workspace-scoped TaskStore keyed by the given scope identifier (typically a resolved cwd).
 */
export function createTaskStore(_scopeId: string): TaskStore {
    return {
        currentListId: null,
        lists: new Map<string, TaskList>(),
    };
}
