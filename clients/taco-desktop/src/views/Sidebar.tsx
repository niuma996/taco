/**
 * Sidebar — workspace session list with rename/delete actions.
 *
 * Pure view: takes WorkspaceState and callbacks; holds no business state.
 * Rendered only when expanded — the parent omits it entirely when collapsed,
 * and the expand affordance lives in the topbar next to the workspace picker.
 */

import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkspaceState } from "../hooks/useWorkspaces";
import { useT, useUiLanguage } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime";

export interface SidebarProps {
    ws: WorkspaceState | undefined;
    onAttach: (sid: string) => void;
    onDelete: (sid: string) => void;
    onRename: (sid: string) => void;
    onLoadMore?: () => void;
    isLoadingMore?: boolean;
}

export function Sidebar(props: SidebarProps) {
    const { t } = useT();
    const { ws, onAttach, onDelete, onRename, onLoadMore, isLoadingMore } = props;
    const lng = useUiLanguage();
    // 30s tick so relative times ("2 minutes ago") advance without a reload;
    // coarse enough to avoid re-rendering the whole list every second.
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNowMs(Date.now()), 30_000);
        return () => clearInterval(id);
    }, []);
    return (
        <aside className="sidebar">
            {/* Scroll container: header stays fixed; min-height:0 lets flex children collapse correctly. */}
            <div className="sidebar-list">
                {ws?.sessions.map((s) => (
                    <div
                        key={s.id}
                        className={`session-item ${ws.activeSession === s.id ? "active" : ""}`}
                        onClick={() => onAttach(s.id)}
                    >
                        <div className="session-meta">
                            <div className="session-main">
                                <span
                                    className={`session-status-dot ${ws.pendingBySessionId[s.id] ? "running" : "idle"}`}
                                    aria-hidden="true"
                                />
                                <div className="session-id" title={s.name || undefined}>
                                    {s.name || s.id.slice(0, 8)}
                                </div>
                            </div>
                            <div className="session-time">
                                {formatRelativeTime(s.updatedAt ?? s.createdAt, lng, nowMs)}
                            </div>
                        </div>
                        <div className="session-actions">
                            <button
                                className="session-rename"
                                title={t("session.rename")}
                                aria-label={t("session.rename")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRename(s.id);
                                }}
                            >
                                <Pencil size={14} aria-hidden="true" />
                            </button>
                            <button
                                className="session-delete"
                                title={t("session.deleteSession")}
                                aria-label={t("session.deleteSession")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(s.id);
                                }}
                            >
                                <Trash2 size={14} aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                ))}
                {ws?.listCursor && onLoadMore && (
                    <button
                        type="button"
                        className="session-load-more"
                        onClick={onLoadMore}
                        disabled={isLoadingMore}
                    >
                        {isLoadingMore ? t("session.loadingMore") : t("session.loadMore")}
                        {ws.listTotal !== undefined && ws.listTotal > ws.sessions.length && (
                            <span className="session-load-more-count">
                                {" "}
                                ({ws.sessions.length}/{ws.listTotal})
                            </span>
                        )}
                    </button>
                )}
            </div>
        </aside>
    );
}
