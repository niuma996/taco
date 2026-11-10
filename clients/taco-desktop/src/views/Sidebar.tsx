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

import { Plus } from "lucide-react";
import { useState } from "react";
import { PaneSearch } from "../components/PaneSearch";
import { SessionList } from "../components/SessionList";
import type { UseSessionSearchResult } from "../hooks/useSessionSearch";
import type { WorkspaceState } from "../hooks/useWorkspaces";
import { useT } from "../i18n/useI18n";
import { conversationActivityKey, getConversationActivity } from "../lib/chat/conversationActivity";

export interface SidebarProps {
    /** Embed the session list in a workspace group with a shared outer scroll area. */
    embedded?: boolean;
    showHeader?: boolean;
    /** Override the highlighted session when the list is embedded in a multi-workspace view. */
    activeSessionId?: string | null;
    ws: WorkspaceState | undefined;
    unread?: Readonly<Record<string, true>>;
    onAttach: (sid: string) => void;
    onDelete: (sid: string) => void;
    onRename: (sid: string) => void;
    onLoadMore?: () => void;
    isLoadingMore?: boolean;
    loadMoreError?: boolean;
    /** Same action as the topbar / session-bar "new chat" button. */
    onNewSession?: () => void;
    newSessionDisabled?: boolean;
    /** Server-side session search (see useSessionSearch). */
    search: UseSessionSearchResult;
}

export function Sidebar(props: SidebarProps) {
    const { t } = useT();
    const { ws, onAttach, onDelete, onRename, onLoadMore, isLoadingMore, loadMoreError } = props;
    const { onNewSession, newSessionDisabled, search } = props;
    const searching = search.query.trim() !== "";
    const [searchOpen, setSearchOpen] = useState(searching);

    // A query switches the list to the server's matches. The box's own text
    // decides, not the debounced query, so the mode flips as soon as the
    // user types.
    const sessions = searching ? search.sessions : (ws?.sessions ?? []);
    // Both the button and its count describe the list on screen: the
    // workspace's sessions normally, the matches while searching.
    const moreCursor = searching ? search.cursor : ws?.listCursor;
    const moreTotal = searching ? search.total : ws?.listTotal;
    const moreLoading = searching ? search.loading : isLoadingMore;
    // The hook refuses to page while the typed query is still debouncing.
    const moreDisabled = searching ? search.loading || search.pending : isLoadingMore;
    const loadMore = searching ? search.loadMore : onLoadMore;
    const Container = props.embedded ? "section" : "aside";

    return (
        <Container className={props.embedded ? "session-list-panel" : "sidebar"}>
            {/* Pinned header — outside .sidebar-list so it stays put while the
                list scrolls. The new-chat button stays mounted and collapses
                with the same max-width/opacity slide as PaneSearch's input
                wrap, so the two swap places without a pop in either
                direction. */}
            {props.showHeader !== false && (
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
                        initiallyOpen={searching}
                        onQueryChange={search.setQuery}
                        onOpenChange={setSearchOpen}
                    />
                </div>
            )}
            {/* Scroll container: header stays fixed; min-height:0 lets flex children collapse correctly. */}
            <SessionList
                className="sidebar-list"
                items={sessions.map((session) => ({
                    key: session.id,
                    id: session.id,
                    label: session.name || session.id.slice(0, 8),
                    updatedAt: session.updatedAt ?? session.createdAt,
                    ...getConversationActivity(ws, session.id),
                    unread: Boolean(
                        ws &&
                            props.unread?.[
                                conversationActivityKey({
                                    workspace: ws.cwd,
                                    sessionId: session.id,
                                })
                            ],
                    ),
                    active:
                        (props.activeSessionId === undefined
                            ? ws?.activeSession
                            : props.activeSessionId) === session.id,
                }))}
                onOpen={(item) => onAttach(item.id)}
                onRename={(item) => onRename(item.id)}
                onDelete={(item) => onDelete(item.id)}
            >
                {searching && sessions.length === 0 && (
                    <li className="session-empty">
                        {search.failed
                            ? t("session.searchFailed")
                            : search.pending || search.loading
                              ? t("session.searching")
                              : t("session.noSearchResults")}
                    </li>
                )}
                {moreCursor && loadMore && loadMoreError && (
                    <li className="session-load-error" role="status">
                        <span>{t("conversationNav.loadFailed")}</span>
                        <button type="button" onClick={loadMore} disabled={isLoadingMore}>
                            {isLoadingMore ? t("session.loadingMore") : t("conversationNav.retry")}
                        </button>
                    </li>
                )}
                {moreCursor && loadMore && !loadMoreError && (
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
            </SessionList>
        </Container>
    );
}
