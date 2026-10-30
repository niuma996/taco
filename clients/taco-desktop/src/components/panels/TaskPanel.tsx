import { asSessionId, type TaskItem, type WorkspaceId } from "@taco-ai/protocol";
import {
    ChevronDown,
    ChevronRight,
    Circle,
    CircleCheck,
    CircleX,
    LoaderCircle,
} from "lucide-react";
import { useState } from "react";
import type { DragHandleProps } from "../../hooks/primitives/useDragResize";
import { useTaskSnapshot } from "../../hooks/useTaskSnapshot";
import { useT } from "../../i18n/useI18n";
import type { WorkspaceAction, WorkspaceState } from "../../lib/chat/workspaceReducer";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { RightPanel } from "./RightPanel";

/**
 * Renders the current session's task list.
 *
 * Open/close is controlled by the parent (session-bar toggle button). When
 * open with no tasks, an empty placeholder is shown instead of nothing.
 * Active tasks get an icon per status (spinning loader / circle / check / x).
 * History rows show an inline badge `{completedCount}/{taskCount}` and expand
 * on click to show details.
 *
 * `workspaces` is a prop (not fetched via useTaskSnapshot → useWorkspaces) to
 * avoid a dual-reducer bug where the two state instances diverge.
 */
export function TaskPanel({
    cwd,
    workspaces,
    sid,
    client,
    dispatchWs,
    open,
    onClose,
    resizeHandleProps,
    resizeLabel,
}: {
    cwd: WorkspaceId;
    workspaces: Record<string, WorkspaceState>;
    sid: string;
    client: TacoClient;
    dispatchWs: (action: WorkspaceAction) => void;
    open: boolean;
    onClose: () => void;
    resizeHandleProps?: DragHandleProps;
    resizeLabel?: string;
}) {
    const { active, history } = useTaskSnapshot(workspaces, cwd, sid);
    const { t } = useT();

    if (!open) return null;

    // History details fetched per (session, listId). Undefined → triggers the RPC.
    const details = workspaces[cwd]?.historyDetailsBySessionId[sid] ?? {};
    const hasTasks = active !== null || history.length > 0;

    return (
        <RightPanel
            title={active ? active.name : t("tasks.title")}
            onClose={onClose}
            closeLabel={t("tasks.closeLabel")}
            className="task-panel"
            resizeHandleProps={resizeHandleProps}
            resizeLabel={resizeLabel}
        >
            {!hasTasks && <div className="task-panel-empty">{t("tasks.empty")}</div>}
            {active && (
                <section className="task-panel-active" aria-label={t("tasks.activeLabel")}>
                    <ul className="task-list">
                        {active.tasks.map((t) => (
                            <TaskRow key={t.id} task={t} />
                        ))}
                    </ul>
                </section>
            )}
            {history.length > 0 && (
                <section className="task-panel-history" aria-label={t("tasks.historyLabel")}>
                    <h3 className="task-history-heading">{t("tasks.historyLabel")}</h3>
                    <ul className="task-history-list">
                        {history.map((h) => (
                            <HistoryRow
                                key={h.id}
                                cwd={cwd}
                                sid={sid}
                                listId={h.id}
                                name={h.name}
                                taskCount={h.taskCount}
                                completedCount={h.completedCount}
                                loaded={details[h.id]?.tasks}
                                client={client}
                                dispatchWs={dispatchWs}
                            />
                        ))}
                    </ul>
                </section>
            )}
        </RightPanel>
    );
}

/** Single task row: icon + content + inline status. */
function TaskRow({ task }: { task: TaskItem }) {
    return (
        <li className={`task-row task-row-${task.status}`}>
            <StatusIcon status={task.status} />
            <span className="task-row-content">{task.content}</span>
        </li>
    );
}

/** Status icon: 1:1 mapping with status, preserving original semantics. */
function StatusIcon({ status }: { status: TaskItem["status"] }) {
    const { t } = useT();
    switch (status) {
        case "in_progress":
            return (
                <LoaderCircle
                    size={14}
                    className="task-icon spinning"
                    aria-label={t("tasks.statusInProgress")}
                />
            );
        case "pending":
            return <Circle size={14} className="task-icon" aria-label={t("tasks.statusPending")} />;
        case "completed":
            return (
                <CircleCheck
                    size={14}
                    className="task-icon task-icon-done"
                    aria-label={t("tasks.statusCompleted")}
                />
            );
        case "failed":
            return (
                <CircleX
                    size={14}
                    className="task-icon task-icon-failed"
                    aria-label={t("tasks.statusFailed")}
                />
            );
    }
}

/**
 * Single history row: title + inline status badge + clickable expand for
 * detail.
 * Status badge: `{completedCount}/{taskCount} completed` (appends
 * `· {n} failed` if there are failures).
 */
function HistoryRow({
    cwd,
    sid,
    listId,
    name,
    taskCount,
    completedCount,
    loaded,
    client,
    dispatchWs,
}: {
    cwd: WorkspaceId;
    sid: string;
    listId: string;
    name: string;
    taskCount: number;
    completedCount: number;
    loaded: TaskItem[] | undefined;
    client: TacoClient;
    dispatchWs: (action: WorkspaceAction) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { t } = useT();

    const failedCount = loaded?.filter((t) => t.status === "failed").length ?? 0;

    const toggle = () => {
        if (loading) return;
        if (!loaded && !expanded) {
            // First expand → fetch once. When `loaded` is already populated, just toggle.
            setLoading(true);
            setError(null);
            client
                .sessionTaskHistoryGet({ workspace: cwd, sessionId: asSessionId(sid), listId })
                .then((tasks) => {
                    dispatchWs({
                        type: "HISTORY_DETAIL_LOADED",
                        cwd,
                        sid,
                        listId,
                        tasks,
                    });
                    setExpanded(true);
                })
                .catch((e: unknown) => {
                    setError(e instanceof Error ? e.message : String(e));
                    setExpanded(true); // Expand to surface the error message.
                })
                .finally(() => setLoading(false));
            return;
        }
        setExpanded((e) => !e);
    };

    return (
        <li className="task-history-row-wrap">
            <button
                type="button"
                className="task-history-row"
                onClick={toggle}
                aria-expanded={expanded}
            >
                {expanded ? (
                    <ChevronDown size={12} aria-hidden="true" />
                ) : (
                    <ChevronRight size={12} aria-hidden="true" />
                )}
                <span className="task-history-name">{name}</span>
                <span className="task-history-badge">
                    {t("tasks.historyBadgeCompleted", {
                        completed: completedCount,
                        total: taskCount,
                    })}
                    {failedCount > 0 &&
                        ` · ${t("tasks.historyBadgeFailed", { failed: failedCount })}`}
                </span>
            </button>
            {expanded && (
                <div className="task-history-detail">
                    {loading && (
                        <div className="task-history-loading">{t("tasks.historyLoading")}</div>
                    )}
                    {error && (
                        <div className="task-history-error" role="alert">
                            {t("tasks.historyLoadFailed", { error })}
                        </div>
                    )}
                    {!loading && !error && loaded && (
                        <ul className="task-list">
                            {loaded.length === 0 ? (
                                <li className="task-history-empty">{t("tasks.historyEmpty")}</li>
                            ) : (
                                loaded.map((t) => <TaskRow key={t.id} task={t} />)
                            )}
                        </ul>
                    )}
                </div>
            )}
        </li>
    );
}
