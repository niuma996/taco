import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { findActiveListId } from "../tasks/activeList.ts";
import type { TaskStore } from "../tasks/taskTypes.ts";

const taskListSchema = Type.Object({});

export function createTaskListTool(store: TaskStore): AgentHarnessTool<ExecutionToolContext> {
    return {
        name: "taskList",
        label: "taskList",
        description:
            "List this session's task lists: the active list (with each task's id/status/content, for " +
            "taskUpdate) plus completed (history) lists as one-line summaries.",
        parameters: taskListSchema,
        executionMode: "sequential",
        taco: {
            promptSummary: "List persistent tasks with their statuses. Read-only.",
            mutates: false,
        },
        async execute(): Promise<{ content: TextContent[]; details: Record<string, never> }> {
            const activeId = findActiveListId(store);
            const lines: string[] = [];
            if (activeId) {
                const list = store.lists.get(activeId);
                if (list) {
                    lines.push(`Active list "${list.name}":`);
                    for (const t of list.tasks) {
                        const mark =
                            t.status === "completed" ? "x" : t.status === "failed" ? "!" : " ";
                        lines.push(`- id=${t.id} [${mark}] ${t.content} (${t.status})`);
                    }
                }
            }
            const history = [...store.lists.values()].filter((l) => l.id !== activeId);
            if (history.length > 0) {
                lines.push("History:");
                for (const l of history) {
                    const done = l.tasks.filter((t) => t.status === "completed").length;
                    const failed = l.tasks.filter((t) => t.status === "failed").length;
                    const suffix = failed > 0 ? `, ${failed} failed` : "";
                    lines.push(`- ${l.name} (${l.tasks.length} tasks, ${done} completed${suffix})`);
                }
            }
            if (lines.length === 0) lines.push("No task lists yet.");
            return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        },
    };
}
