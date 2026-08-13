import type { ContextEvent, ContextResult } from "@earendil-works/pi-agent-core";
import { createUserMessage, tagWrap } from "../tags/builder.ts";
import type { PlanModeState } from "../tools/planModeState.ts";
import { findActiveListId } from "./activeList.ts";
import type { TaskStore } from "./taskTypes.ts";
import { isUnfinishedStatus } from "./taskTypes.ts";

export interface ActiveTasksState {
    store: TaskStore;
    planActive: boolean;
    planState: PlanModeState;
}

/**
 * Each LLM context build, if the session has unfinished active tasks, injects
 * an <active_tasks> prompt: continuing work → resume; new topic → terminate
 * via taskUpdate first. Suppressed when plan mode is active (clashes with
 * plan_mode_directive's read-only constraint).
 */
export function buildActiveTasksContextHook(
    getState: () => ActiveTasksState,
): (event: ContextEvent) => Promise<ContextResult | undefined> {
    return async (event: ContextEvent): Promise<ContextResult | undefined> => {
        const { store, planActive } = getState();
        if (planActive) return undefined;
        const activeId = store.currentListId ?? findActiveListId(store);
        if (!activeId) return undefined;
        const list = store.lists.get(activeId);
        if (!list) return undefined;
        const unfinished = list.tasks.filter((t) => isUnfinishedStatus(t.status));
        if (unfinished.length === 0) return undefined;
        const lines = unfinished.map((t) => `- id=${t.id} (${t.status}) ${t.content}`);
        const body = `Active task list "${list.name}" has ${unfinished.length} unfinished task(s):\n${lines.join("\n")}\n\nIf the user's message continues this work (e.g. '继续', 'go on'), resume the next unfinished task and taskUpdate each to completed as you finish it. If the user changed topic, first taskUpdate the remaining tasks to failed (终止), then proceed.`;
        event.messages.unshift(createUserMessage(tagWrap("active_tasks", body)));
        return { messages: event.messages };
    };
}
