import { randomBytes } from "node:crypto";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext, TextContent } from "../runtime/pi/types.ts";
import { findActiveListId } from "../tasks/activeList.ts";
import { addTask, createTaskList } from "../tasks/taskMutations.ts";
import { saveTaskListToDisk } from "../tasks/taskPersistence.ts";
import type { TaskSnapshotPublisher } from "../tasks/taskPushAdapter.ts";

import { type TaskStore, taskItemSchema } from "../tasks/taskTypes.ts";

const todoWriteSchema = Type.Object({
    todos: Type.Array(taskItemSchema),
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

export function createTodoWriteTool(
    store: TaskStore,
    tasksDir: string,
    adapter: TaskSnapshotPublisher,
    sessionId: SessionId,
): AgentHarnessTool<ExecutionToolContext> {
    return {
        name: "todoWrite",
        label: "todoWrite",
        description:
            "Replace the current active task list with a fresh list. Use to break a multi-step task " +
            "into trackable steps the user sees live. The replacement is total — any task IDs from the " +
            "previous list become invalid. Creates the list if none is active yet.\n" +
            "\n" +
            "Delegate a subtask only when the agent tool is available, the work is independent, and " +
            "delegation helps complete the requested result. Tool-call count alone does not justify " +
            "delegation. Keep coupled work and short investigations in the current session.",
        parameters: todoWriteSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Replace this session's persisted active task list in full; previous task IDs become invalid. Use taskUpdate for individual status changes and taskCreate to start a new named list when none is active.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: TodoWriteInput,
            _onUpdate: unknown,
            context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: { taskCount: number } }> {
            let listId = store.currentListId ?? findActiveListId(store);
            if (!listId) {
                listId = `list-${randomBytes(3).toString("hex")}`;
                createTaskList(store, listId, "Tasks");
                store.currentListId = listId;
            }
            const list = store.lists.get(listId);
            if (!list) throw new Error(`Task list not found: ${listId}`);
            list.tasks = [];
            for (const todo of params.todos) {
                addTask(store, listId, todo);
            }
            await saveTaskListToDisk(tasksDir, list);
            adapter.publishTasksUpdated(context.env.cwd as WorkspaceId, sessionId, store);
            return {
                content: [{ type: "text", text: `${params.todos.length} tasks updated` }],
                details: { taskCount: params.todos.length },
            };
        },
    };
}
