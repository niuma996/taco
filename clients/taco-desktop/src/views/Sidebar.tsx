/**
 * Sidebar — workspace session list with rename/delete actions.
 *
 * Pure view: takes WorkspaceState, the search API and callbacks; holds only
 * the search box's open state. Always mounted in the chat view — collapse is
 * a CSS width transition driven by .layout[data-sidebar-collapsed], so the
 * list wipes in/out and keeps its scroll position across toggles.
 *
 * While a query is active the list shows the server's matches instead of the
 * workspace's sessions, and "load more" pages through those matches.
 */

import { Pencil, Plus, Trash } from "lucide-react";
import { useState } from "react";
import { PaneSearch } from "../components/PaneSearch";
import { IconButton } from "../components/ui/IconButton";
import { useNow } from "../hooks/useNow";
import type { UseSessionSearchResult } from "../hooks/useSessionSearch";
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
    /** Same action as the topbar / session-bar "new chat" button. */
    onNewSession?: () => void;
    newSessionDisabled?: boolean;
    /** Server-side session search (see useSessionSearch). */
    search: UseSessionSearchResult;
}

export function Sidebar(props: SidebarProps) {
    const { t } = useT();
    const { ws, onAttach, onDelete, onRename, onLoadMore, isLoadingMore } = props;
    const { onNewSession, newSessionDisabled, search } = props;
    const lng = useUiLanguage();
    const nowMs = useNow();
    const [searchOpen, setSearchOpen] = useState(false);

    // A query switches the list to the server's matches. The box's own text
    // decides, not the debounced query, so the mode flips as soon as the
    // user types.
    const searching = search.query.trim() !== "";
    const sessions = searching ? search.sessions : (ws?.sessions ?? []);
    // Both the button and its count describe the list on screen: the
    // workspace's sessions normally, the matches while searching.
    const moreCursor = searching ? search.cursor : ws?.listCursor;
    const moreTotal = searching ? search.total : ws?.listTotal;
    const moreLoading = searching ? search.loading : isLoadingMore;
    // The hook refuses to page while the typed query is still debouncing.
    const moreDisabled = searching ? search.loading || search.pending : isLoadingMore;
    const loadMore = searching ? search.loadMore : onLoadMore;

    return (
        <aside className="sidebar">
            {/* Pinned header — outside .sidebar-list so it stays put while the
                list scrolls. The new-chat button stays mounted and collapses
                with the same max-width/opacity slide as PaneSearch's input
                wrap, so the two swap places without a pop in either
                direction. */}
            <div className="sidebar-header">
                {onNewSession && (
                    <span
                        className={`sidebar-new-chat-wrap${searchOpen ? "" : " open"}`}
                        aria-hidden={searchOpen}
                        inert={searchOpen}
                    >
                        <button
                            type="button"
                            className="sidebar-new-chat"
                            onClick={onNewSession}
                            disabled={newSessionDisabled}
                            tabIndex={searchOpen ? -1 : 0}
                        >
                            <Plus size={14} aria-hidden="true" />
                            {t("session.newChat")}
                        </button>
                    </span>
                )}
                <PaneSearch
                    query={search.query}
                    onQueryChange={search.setQuery}
                    onOpenChange={setSearchOpen}
                />
            </div>
            {/* Scroll container: header stays fixed; min-height:0 lets flex children collapse correctly. */}
            <div className="sidebar-list">
                {sessions.map((s) => (
                    <div
                        key={s.id}
                        className={`session-item ${ws?.activeSession === s.id ? "active" : ""}`}
                        onClick={() => onAttach(s.id)}
                    >
                        <div className="session-meta">
                            <div className="session-main">
                                <span
                                    className={`session-status-dot ${ws?.pendingBySessionId[s.id] ? "running" : "idle"}`}
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
                            <IconButton
                                className="session-action"
                                title={t("session.rename")}
                                aria-label={t("session.rename")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRename(s.id);
                                }}
                            >
                                <Pencil size={14} aria-hidden="true" />
                            </IconButton>
                            <IconButton
                                tone="danger"
                                className="session-action"
                                title={t("session.deleteSession")}
                                aria-label={t("session.deleteSession")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(s.id);
                                }}
                            >
                                <Trash size={14} aria-hidden="true" />
                            </IconButton>
                        </div>
                    </div>
                ))}
                {searching && sessions.length === 0 && (
                    <div className="session-empty">
                        {search.failed
                            ? t("session.searchFailed")
                            : search.pending || search.loading
                              ? t("session.searching")
                              : t("session.noSearchResults")}
                    </div>
                )}
                {moreCursor && loadMore && (
                    <button
                        type="button"
                        className="session-load-more"
                        onClick={loadMore}
                        disabled={moreDisabled}
                    >
                        {moreLoading ? t("session.loadingMore") : t("session.loadMore")}
                        {moreTotal !== undefined && moreTotal > sessions.length && (
                            <span className="session-load-more-count">
                                {" "}
                                ({sessions.length}/{moreTotal})
                            </span>
                        )}
                    </button>
                )}
            </div>
        </aside>
    );
}
