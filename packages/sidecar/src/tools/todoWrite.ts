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

const todoWriteSchema = Type.Object({
    todos: Type.Array(
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
            "For complex subtasks (broad scope, independent investigation, >5 tool calls, or long-running " +
            "work like codebase exploration / refactor / migration), prefer delegating to a subagent via " +
            "the Task tool with worktree isolation — keeps the main session's context lean and lets you " +
            "parallelize independent subtasks. Reserve direct tools in the main session for tightly-coupled " +
            "steps that share state with the current task's outputs.",
        parameters: todoWriteSchema,
        executionMode: "sequential",
        taco: {
            promptSummary:
                'Internal task list for *this* turn — replaces the whole list each call. Use for short-lived breakdowns ("here is what I\'m about to do"). For persistent tasks across sessions, use taskCreate.',
            mutates: true,
        },
        async execute(
            _toolCallId: string,
            params: TodoWriteInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
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
