import type { TaskList, TaskStore } from "./taskTypes.ts";
import { isUnfinishedStatus } from "./taskTypes.ts";

/** Active when the list has any unfinished task (pending / in_progress).
 *  completed and failed are both terminal. */
export function isListActive(list: TaskList): boolean {
    return list.tasks.some((t) => isUnfinishedStatus(t.status));
}

/**
 * Active list id — first active list in store.lists. Returns null when none
 * are active or all are complete.
 */
export function findActiveListId(store: TaskStore): string | null {
    for (const list of store.lists.values()) {
        if (isListActive(list)) return list.id;
    }
    return null;
}
