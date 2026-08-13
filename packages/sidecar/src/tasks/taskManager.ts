import type { TaskItem } from "@taco-ai/protocol";
import type { Task, TaskList, TaskStore } from "./taskTypes.ts";

export function createTaskList(store: TaskStore, id: string, name: string): TaskList {
    const now = new Date().toISOString();
    const list: TaskList = {
        id,
        name,
        tasks: [],
        metadata: {
            nextTaskId: 1,
        },
        createdAt: now,
        updatedAt: now,
    };
    store.lists.set(id, list);
    return list;
}

export function addTask(
    store: TaskStore,
    listId: string,
    input: { content: string; status: TaskItem["status"]; activeForm: string },
): Task {
    const list = store.lists.get(listId);
    if (!list) {
        throw new Error(`Task list not found: ${listId}`);
    }

    const now = new Date().toISOString();
    const task: Task = {
        id: `task-${list.metadata.nextTaskId}`,
        content: input.content,
        status: input.status,
        activeForm: input.activeForm,
        createdAt: now,
        updatedAt: now,
    };

    list.metadata.nextTaskId += 1;
    list.tasks.push(task);
    list.updatedAt = now;

    return task;
}
export function updateTask(
    store: TaskStore,
    listId: string,
    taskId: string,
    updates: Partial<Pick<Task, "content" | "status" | "activeForm">>,
): Task {
    const list = store.lists.get(listId);
    if (!list) {
        throw new Error(`Task list not found: ${listId}`);
    }

    const task = list.tasks.find((t) => t.id === taskId);
    if (!task) {
        throw new Error(`Task not found: ${taskId}`);
    }

    if (updates.content !== undefined) task.content = updates.content;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
    task.updatedAt = new Date().toISOString();
    list.updatedAt = new Date().toISOString();

    return task;
}
