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
import { type KeyboardEvent, useRef, useState } from "react";
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
    const listRef = useRef<HTMLUListElement>(null);

    // Same keyboard pattern as WorkPane: ArrowUp/Down/Home/End move focus
    // between rows; Enter/Space activate the focused row natively.
    const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        // Only steer focus when a row itself is focused; otherwise the action
        // buttons inside a row would lose Home/End/arrow interactions.
        if (!(event.target instanceof HTMLElement) || !event.target.closest("[data-session-row]"))
            return;
        const rows = Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-row]") ?? [],
        );
        if (rows.length === 0) return;
        event.preventDefault();
        const current = rows.indexOf(document.activeElement as HTMLButtonElement);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : Math.min(
                        rows.length - 1,
                        Math.max(
                            0,
                            (current < 0 ? -1 : current) + (event.key === "ArrowDown" ? 1 : -1),
                        ),
                    );
        rows[index]?.focus();
    };

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
            <ul className="sidebar-list" ref={listRef} onKeyDown={handleListKeyDown}>
                {sessions.map((s) => (
                    <li
                        key={s.id}
                        className={`session-item ${ws?.activeSession === s.id ? "active" : ""}`}
                    >
                        {/* The row's main click target is a real button so the
                            list is keyboard-reachable; the hover actions stay
                            siblings because nested <button> is invalid. */}
                        <button
                            type="button"
                            className="session-item-main"
                            data-session-row={s.id}
                            onClick={() => onAttach(s.id)}
                        >
                            {/* Only phrasing content inside <button>: spans,
                                styled as the original flex boxes. */}
                            <span className="session-meta">
                                <span className="session-main">
                                    <span
                                        className={`session-status-dot ${ws?.pendingBySessionId[s.id] ? "running" : "idle"}`}
                                        aria-hidden="true"
                                    />
                                    <span className="session-id" title={s.name || undefined}>
                                        {s.name || s.id.slice(0, 8)}
                                    </span>
                                </span>
                                <span className="session-time">
                                    {formatRelativeTime(s.updatedAt ?? s.createdAt, lng, nowMs)}
                                </span>
                            </span>
                        </button>
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
                    </li>
                ))}
                {searching && sessions.length === 0 && (
                    <li className="session-empty">
                        {search.failed
                            ? t("session.searchFailed")
                            : search.pending || search.loading
                              ? t("session.searching")
                              : t("session.noSearchResults")}
                    </li>
                )}
                {moreCursor && loadMore && (
                    <li>
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
                    </li>
                )}
            </ul>
        </aside>
    );
}
