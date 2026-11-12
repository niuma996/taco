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

const taskCreateSchema = Type.Object({
    listName: Type.String({ description: "Task list name" }),
    tasks: Type.Array(taskItemSchema),
});

export type TaskCreateInput = Static<typeof taskCreateSchema>;

export function createTaskCreateTool(
    store: TaskStore,
    tasksDir: string,
    adapter: TaskSnapshotPublisher,
    sessionId: SessionId,
): AgentHarnessTool<ExecutionToolContext> {
    return {
        name: "taskCreate",
        label: "taskCreate",
        description:
            "Start a new named task list and make it active. Use for tracked, multi-step work the user " +
            "should follow. Only ONE list may be active at a time — if one is already active (has " +
            "unfinished tasks), finish it (taskUpdate each task to completed/failed) or replace it with " +
            "todoWrite first. Each created task gets a stable id (task-N) to reuse in taskUpdate.\n" +
            "\n" +
            "Delegate a subtask only when the agent tool is available, the work is independent, and " +
            "delegation helps complete the requested result. Tool-call count alone does not justify " +
            "delegation. Keep coupled work and short investigations in the current session.",
        parameters: taskCreateSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Start a named task list persisted for this session when none is active. Use for work the user wants tracked. Reuse the returned task IDs with taskUpdate; use todoWrite to replace the active list in full.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: TaskCreateInput,
            _onUpdate: unknown,
            context: ExecutionToolContext,
        ): Promise<{
            content: TextContent[];
            details: { listId: string | null; taskCount: number; taskIds: string[] };
        }> {
            const existingActive = findActiveListId(store);
            if (existingActive) {
                const existing = store.lists.get(existingActive);
                return {
                    content: [
                        {
                            type: "text",
                            text: `A task list "${existing?.name ?? existingActive}" is still active with unfinished tasks. Only one list can be active at a time. Either finish the current list (taskUpdate each remaining task to completed/failed), or replace it wholesale with todoWrite. No new list was created.`,
                        },
                    ],
                    details: { listId: null, taskCount: 0, taskIds: [] },
                };
            }
            const listId = `list-${randomBytes(3).toString("hex")}`;
            const list = createTaskList(store, listId, params.listName);
            store.currentListId = listId;
            const taskIds: string[] = [];
            for (const task of params.tasks) {
                taskIds.push(addTask(store, listId, task).id);
            }
            await saveTaskListToDisk(tasksDir, list);
            adapter.publishTasksUpdated(context.env.cwd as WorkspaceId, sessionId, store);
            return {
                content: [
                    {
                        type: "text",
                        text: `Created list "${params.listName}" with ${taskIds.length} tasks: ${taskIds.join(", ")}`,
                    },
                ],
                details: { listId, taskCount: taskIds.length, taskIds },
            };
        },
    };
}
