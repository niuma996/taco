import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { findActiveListId } from "../tasks/activeList.ts";
import { updateTask } from "../tasks/taskManager.ts";
import { saveTaskListToDisk } from "../tasks/taskPersistence.ts";
import type { TaskSnapshotPublisher } from "../tasks/taskPushAdapter.ts";

import type { TaskStore } from "../tasks/taskTypes.ts";
import { isUnfinishedStatus } from "../tasks/taskTypes.ts";

const taskUpdateSchema = Type.Object({
    taskId: Type.String({ description: "Task ID (from taskCreate output / taskList)" }),
    updates: Type.Object({
        content: Type.Optional(Type.String()),
        status: Type.Optional(
            Type.Union(
                [
                    Type.Literal("pending"),
                    Type.Literal("in_progress"),
                    Type.Literal("completed"),
                    Type.Literal("failed"),
                ],
                {
                    description:
                        "Task status. Both `failed` and `completed` are terminal; use `failed` to abandon remaining tasks when the topic changes.",
                },
            ),
        ),
        activeForm: Type.Optional(Type.String()),
    }),
});

export type TaskUpdateInput = Static<typeof taskUpdateSchema>;

export function createTaskUpdateTool(
    store: TaskStore,
    tasksDir: string,
    adapter: TaskSnapshotPublisher,
    sessionId: SessionId,
): AgentHarnessTool<ExecutionToolContext> {
    return {
        name: "taskUpdate",
        label: "taskUpdate",
        description: "Update an existing task's status, content, or active form.",
        parameters: taskUpdateSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Update a persistent task (status, content, dependency). References the task by id returned from taskCreate / taskList.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: TaskUpdateInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            context: ExecutionToolContext,
        ): Promise<{ content: TextContent[]; details: { taskId: string } }> {
            const listId = store.currentListId ?? findActiveListId(store);
            if (!listId) {
                throw new Error(
                    "No active task list. Create one with taskCreate or todoWrite first.",
                );
            }

            const task = updateTask(store, listId, params.taskId, params.updates);

            const list = store.lists.get(listId);
            if (list) {
                await saveTaskListToDisk(tasksDir, list);
                if (list.tasks.every((t) => !isUnfinishedStatus(t.status))) {
                    store.currentListId = null;
                }
                adapter.publishTasksUpdated(context.env.cwd as WorkspaceId, sessionId, store);
            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Task "${task.content}" updated`,
                    },
                ],
                details: {
                    taskId: params.taskId,
                },
            };
        },
    };
}
