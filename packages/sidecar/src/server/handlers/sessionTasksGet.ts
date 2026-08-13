import type { TaskItem, TaskListMeta, TasksUpdatedParams } from "@taco-ai/protocol";
import { findActiveListId } from "../../tasks/activeList.ts";
import type { TaskStore } from "../../tasks/taskTypes.ts";
import { isUnfinishedStatus } from "../../tasks/taskTypes.ts";

/** Build the {active, history} shape shared by session.tasks.get and tasks.updated. */
export function buildTasksGetResult(store: TaskStore): {
    active: TasksUpdatedParams["active"];
    history: TaskListMeta[];
} {
    const activeId = store.currentListId ?? findActiveListId(store);
    const activeList = activeId ? store.lists.get(activeId) : undefined;
    const active = activeList?.tasks.some((t) => isUnfinishedStatus(t.status))
        ? {
              id: activeList.id,
              name: activeList.name,
              tasks: activeList.tasks.map(
                  (t): TaskItem => ({
                      id: t.id,
                      content: t.content,
                      status: t.status,
                      activeForm: t.activeForm,
                  }),
              ),
          }
        : null;
    const history: TaskListMeta[] = [...store.lists.values()]
        .filter((l) => l.id !== activeList?.id || active === null)
        .map((l) => ({
            id: l.id,
            name: l.name,
            taskCount: l.tasks.length,
            completedCount: l.tasks.filter((t) => t.status === "completed").length,
        }))
        // Sort by list creation time descending — newest on top. l.id is a
        // non-monotonic randomBytes(3) string and cannot be used for time
        // order; the real creation time lives in store.lists. The wire shape
        // does not expose createdAt.
        .sort((a, b) => {
            const ta = store.lists.get(a.id)?.createdAt ?? "";
            const tb = store.lists.get(b.id)?.createdAt ?? "";
            return tb.localeCompare(ta);
        });
    return { active, history };
}

/**
 * Pull the full task detail of a historical list (on-demand expand).
 * Returns [] if the list is not found or has no tasks. Serialize only
 * wire fields to avoid leaking internal store timestamps.
 */
export function buildHistoryListDetail(store: TaskStore, listId: string): TaskItem[] {
    const list = store.lists.get(listId);
    if (!list) return [];
    return list.tasks.map(
        (t): TaskItem => ({
            id: t.id,
            content: t.content,
            status: t.status,
            activeForm: t.activeForm,
        }),
    );
}
