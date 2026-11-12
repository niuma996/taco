import type { TaskItem } from "@taco-ai/protocol";
import { Type } from "typebox";

/**
 * Task status union shared by the mutation tools' TypeBox schemas. Callers
 * keep their own description, since their guidance to the model differs.
 */
export function taskStatusSchema(description: string) {
    return Type.Union(
        [
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
            Type.Literal("failed"),
        ],
        { description },
    );
}

/** One task as taskCreate / todoWrite accept it; the store adds ids and timestamps. */
export const taskItemSchema = Type.Object({
    content: Type.String({ description: "Task description" }),
    status: taskStatusSchema("Task status"),
    activeForm: Type.String({ description: "In-progress description" }),
});

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
