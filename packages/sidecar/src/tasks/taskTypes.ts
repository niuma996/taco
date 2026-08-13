import type { TaskItem } from "@taco-ai/protocol";

/**
 * Reuses the protocol-layer TaskItem (4-field wire shape) and adds store-private
 * createdAt/updatedAt — locking "wire shape" and "store shape" at the type
 * layer so neither side can silently add fields and break the publishTasksUpdated call
 * mapping or the protocol contract.
 */
export interface Task extends TaskItem {
    createdAt: string;
    updatedAt: string;
}

/**
 * Unfinished predicate: task is still in flight (pending / in_progress).
 * Terminal states (completed / failed) are not unfinished — `failed` means
 * "abandoned" and stops being active. All "is list active / has unfinished
 * tasks" checks must go through this predicate.
 */
export function isUnfinishedStatus(status: TaskItem["status"]): boolean {
    return status === "pending" || status === "in_progress";
}

export interface TaskList {
    /** On-disk schema version. Absent on files written before versioning. */
    schemaVersion?: number;
    id: string;
    name: string;
    tasks: Task[];
    metadata: {
        nextTaskId: number;
    };
    createdAt: string;
    updatedAt: string;
}

export interface TaskStore {
    /** Active list id; null = no active list (initial or all complete). */
    currentListId: string | null;
    lists: Map<string, TaskList>;
}
