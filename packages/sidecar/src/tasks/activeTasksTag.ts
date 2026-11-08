import type { ContextEvent, ContextResult } from "../extensions/types.ts";
import type { PlanModeState } from "../plan/planModeState.ts";
import { appendUserTag } from "../tags/appendUserTag.ts";
import { tagWrap } from "../tags/builder.ts";
import { findActiveListId } from "./activeList.ts";
import type { TaskStore } from "./taskTypes.ts";
import { isUnfinishedStatus } from "./taskTypes.ts";

export interface ActiveTasksState {
    store: TaskStore;
    planActive: boolean;
    planState: PlanModeState;
}

/**
 * Emit changed task snapshots once per attachment; unchanged pending work
 * must not keep resurfacing during unrelated requests. taskList remains
 * available for explicit status checks and resumption.
 * Suppressed when plan mode is active (clashes with
 * plan_mode_directive's read-only constraint).
 */
export function buildActiveTasksContextHook(
    getState: () => ActiveTasksState,
): (event: ContextEvent) => Promise<ContextResult | undefined> {
    let lastSnapshot: string | undefined;
    return async (event: ContextEvent): Promise<ContextResult | undefined> => {
        const { store, planActive } = getState();
        if (planActive) return undefined;
        const activeId = store.currentListId ?? findActiveListId(store);
        if (!activeId) {
            lastSnapshot = undefined;
            return undefined;
        }
        const list = store.lists.get(activeId);
        if (!list) return undefined;
        const unfinished = list.tasks.filter((t) => isUnfinishedStatus(t.status));
        if (unfinished.length === 0) return undefined;
        const snapshot = JSON.stringify([
            list.id,
            list.name,
            unfinished.map((t) => [t.id, t.status, t.content, t.activeForm]),
        ]);
        if (snapshot === lastSnapshot) return undefined;
        const lines = unfinished.map((t) => `- id=${t.id} (${t.status}) ${t.content}`);
        const body = `Active task list "${list.name}" has ${unfinished.length} unfinished task(s):\n${lines.join("\n")}\n\nThis list is progress context, not a new request. Continue tasks that are required by the user's current request and use taskUpdate to mark confirmed outcomes. A status question or temporary topic change does not cancel pending work; preserve it unless the user clearly abandons or replaces it. For canceled or replaced work, mark remaining tasks failed (terminated). A stale pending status does not justify more investigation: if the requested work is complete, update its status and report the result.`;
        appendUserTag(event.messages, tagWrap("active_tasks", body), "system-event");
        lastSnapshot = snapshot;
        return { messages: event.messages };
    };
}
