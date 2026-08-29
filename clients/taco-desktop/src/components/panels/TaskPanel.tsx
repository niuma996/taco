import type { TaskItem, WorkspaceId } from "@taco-ai/protocol";
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Circle,
    Loader2,
    PanelRightClose,
    XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTaskSnapshot } from "../../hooks/useTaskSnapshot";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import type { WorkspaceAction, WorkspaceState } from "../../lib/workspaceReducer";

/**
 * Renders the current session's task list.
 *
 * No tasks and collapsed → render nothing. With active tasks → icon per status
 * (spinning loader / circle / check / x). History rows show an inline badge
 * `{completedCount}/{taskCount}` and expand on click to show details.
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
    forceExpand,
}: {
    cwd: WorkspaceId;
    workspaces: Record<string, WorkspaceState>;
    sid: string;
    client: TacoClient;
    dispatchWs: (action: WorkspaceAction) => void;
    forceExpand: boolean;
}) {
    const { active, history } = useTaskSnapshot(workspaces, cwd, sid);
    const [collapsed, setCollapsed] = useState(false);

    // First write of a snapshot for this sid (taskCreate / todoWrite etc.)
    // dispatches TASK_PANEL_FORCE_EXPAND via useWorkspaces — we consume it
    // here by forcing re-expansion, then clear the flag with CONSUMED.
    // Replaying an old snapshot (re-enter / re-attach) doesn't re-dispatch,
    // so the panel won't keep popping open.
    useEffect(() => {
        if (!forceExpand) return;
        setCollapsed(false);
        dispatchWs({ type: "TASK_PANEL_FORCE_EXPAND_CONSUMED", cwd });
    }, [forceExpand, cwd, dispatchWs]);

    // No tasks: render nothing. Switching sessions also returns this to false
    // (the component remounts).
    if (active === null && history.length === 0) return null;
    if (collapsed) return null;

    // History details fetched per (session, listId). Undefined → triggers the RPC.
    const details = workspaces[cwd]?.historyDetailsBySessionId[sid] ?? {};

    return (
        <div className="task-panel">
            <div className="task-panel-topbar">
                {active ? (
                    <h3 className="task-panel-name">{active.name}</h3>
                ) : (
                    <h3 className="task-panel-name">任务</h3>
                )}
                <button
                    type="button"
                    className="task-panel-collapse"
                    onClick={() => setCollapsed(true)}
                    aria-label="收起任务面板"
                    title="收起任务面板"
                >
                    <PanelRightClose size={14} aria-hidden="true" />
                </button>
            </div>
            {active && (
                <section className="task-panel-active" aria-label="当前任务">
                    <ul className="task-list">
                        {active.tasks.map((t) => (
                            <TaskRow key={t.id} task={t} />
                        ))}
                    </ul>
                </section>
            )}
            {history.length > 0 && (
                <section className="task-panel-history" aria-label="历史任务">
                    <h3 className="task-history-heading">历史任务</h3>
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
        </div>
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
    switch (status) {
        case "in_progress":
            return <Loader2 size={14} className="task-icon spinning" aria-label="进行中" />;
        case "pending":
            return <Circle size={14} className="task-icon" aria-label="待办" />;
        case "completed":
            return (
                <CheckCircle2 size={14} className="task-icon task-icon-done" aria-label="已完成" />
            );
        case "failed":
            return <XCircle size={14} className="task-icon task-icon-failed" aria-label="已失败" />;
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

    const failedCount = loaded?.filter((t) => t.status === "failed").length ?? 0;

    const toggle = () => {
        if (loading) return;
        if (!loaded && !expanded) {
            // First expand → fetch once. When `loaded` is already populated, just toggle.
            setLoading(true);
            setError(null);
            client
                .sessionTaskHistoryGet(cwd, sid, listId)
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
                    {completedCount}/{taskCount} 已完成
                    {failedCount > 0 && ` · ${failedCount} 失败`}
                </span>
            </button>
            {expanded && (
                <div className="task-history-detail">
                    {loading && <div className="task-history-loading">loading…</div>}
                    {error && <div className="task-history-error">加载失败:{error}</div>}
                    {!loading && !error && loaded && (
                        <ul className="task-list">
                            {loaded.length === 0 ? (
                                <li className="task-history-empty">(空)</li>
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
