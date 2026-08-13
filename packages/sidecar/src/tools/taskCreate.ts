import { randomBytes } from "node:crypto";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { SessionId, WorkspaceId } from "@taco-ai/protocol";
import type { Static } from "typebox";
import { Type } from "typebox";
import { findActiveListId } from "../tasks/activeList.ts";
import { addTask, createTaskList } from "../tasks/taskManager.ts";
import { saveTaskListToDisk } from "../tasks/taskPersistence.ts";
import type { TaskSnapshotPublisher } from "../tasks/taskPushAdapter.ts";

import type { TaskStore } from "../tasks/taskTypes.ts";

const taskCreateSchema = Type.Object({
    listName: Type.String({ description: "Task list name" }),
    tasks: Type.Array(
        Type.Object({
            content: Type.String({ description: "Task description" }),
            status: Type.Union(
                [
                    Type.Literal("pending"),
                    Type.Literal("in_progress"),
                    Type.Literal("completed"),
                    Type.Literal("failed"),
                ],
                { description: "Task status" },
            ),
            activeForm: Type.String({ description: "In-progress description" }),
        }),
    ),
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
            "For complex subtasks (broad scope, independent investigation, >5 tool calls, or long-running " +
            "work like codebase exploration / refactor / migration), prefer delegating to a subagent via " +
            "the Task tool with worktree isolation — keeps the main session's context lean and lets you " +
            "parallelize independent subtasks. Reserve direct tools in the main session for tightly-coupled " +
            "steps that share state with the current task's outputs.",
        parameters: taskCreateSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                "Persistent task list that survives across sessions. Use when the user explicitly asks to track / manage work. Reuse the exact id returned by taskCreate on subsequent calls.",
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: TaskCreateInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
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
