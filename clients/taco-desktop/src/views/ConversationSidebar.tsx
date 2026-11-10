import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ImConversationEntry } from "@taco-ai/protocol";
import {
    Check,
    ChevronDown,
    ChevronRight,
    Filter,
    Folder,
    FolderPlus,
    Link2,
    LoaderCircle,
    Plus,
    Search,
    Settings2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SessionList } from "../components/SessionList";
import type { WorkspaceMode } from "../components/WorkspaceModeTabs";
import type { UseSessionSearchesResult } from "../hooks/useSessionSearch";
import { useT } from "../i18n/useI18n";
import { summarizeConversationActivity } from "../lib/chat/conversationActivity";
import {
    buildChannelConversationItems,
    buildWorkspaceGroups,
    type WorkspaceConversationGroup,
} from "../lib/chat/conversationGroups";
import type { WorkspaceState } from "../lib/chat/workspaceReducer";
import { Sidebar } from "./Sidebar";

export interface ConversationSidebarProps {
    mode: WorkspaceMode;
    workspaces: Record<string, WorkspaceState>;
    activeCwd: string;
    expandedWorkspaces?: readonly string[];
    onExpandedWorkspacesChange?: (workspaces: string[]) => void;
    unread?: Readonly<Record<string, true>>;
    conversations: readonly ImConversationEntry[] | null;
    conversationsLoading: boolean;
    conversationsError: string | null;
    searches: UseSessionSearchesResult;
    onOpenSession: (target: { workspace: string; sessionId: string }) => void;
    onSelectWorkspace?: (cwd: string) => void;
    onLoadWorkspace: (cwd: string) => Promise<void>;
    onLoadMore: (cwd: string) => Promise<boolean>;
    onDelete: (target: { cwd: string; sessionId: string }) => void;
    onRename: (target: { cwd: string; sessionId: string; currentName?: string }) => void;
    onNewSession: (cwd: string) => void;
    onOpenFolder?: () => void;
    /** Associate other directories with this filesystem workspace or IM chat. */
    onManageAssociations?: (target: { workspace: string }) => void;
    onRetryConversations: () => void;
    onManageChannels: () => void;
}

export function ConversationSidebar(props: ConversationSidebarProps) {
    const { t } = useT();
    const [openSearches, setOpenSearches] = useState<Set<string>>(() => new Set());
    // Keyed by group cwd: several groups can keep a search open at once, and a
    // single shared ref would be nulled when any one of them unmounts.
    const searchInputRefs = useRef(new Map<string, HTMLInputElement>());
    const pendingSearchFocusRef = useRef<string | null>(null);
    const searchVisible = (groupCwd: string): boolean => openSearches.has(groupCwd);

    useEffect(() => {
        const target = pendingSearchFocusRef.current;
        pendingSearchFocusRef.current = null;
        if (target !== null) {
            searchInputRefs.current.get(target)?.focus();
            return;
        }
        // Closed one of several searches: keep focus in a search that remains.
        const remaining = openSearches.values().next();
        if (!remaining.done) searchInputRefs.current.get(remaining.value)?.focus();
    }, [openSearches]);

    const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(
        () =>
            new Set(
                (props.expandedWorkspaces ?? [props.activeCwd]).map((cwd) => `workspace:${cwd}`),
            ),
    );
    const initializedModeRef = useRef<WorkspaceMode | null>(null);
    const previousActiveCwdRef = useRef(props.activeCwd);
    const [loadingGroups, setLoadingGroups] = useState<Set<string>>(new Set());
    const [failedGroups, setFailedGroups] = useState<Set<string>>(new Set());
    const [loadingMoreGroups, setLoadingMoreGroups] = useState<Set<string>>(new Set());
    const [failedMoreGroups, setFailedMoreGroups] = useState<Set<string>>(new Set());
    const [channelFilter, setChannelFilter] = useState<string | null>(null);
    const workspaceOrderRef = useRef(new Map<string, number>());
    const nextWorkspaceOrderRef = useRef(0);

    const workspaceGroups = useMemo(() => {
        const groups = buildWorkspaceGroups(props.workspaces, props.unread);
        // Freeze the mount-time order for this run. Lazy history, selection
        // and newer session activity never move a directory under the pointer.
        // A workspace opened later is appended without disturbing existing rows.
        for (const group of groups) {
            if (!workspaceOrderRef.current.has(group.cwd)) {
                workspaceOrderRef.current.set(group.cwd, nextWorkspaceOrderRef.current++);
            }
        }
        groups.sort(
            (a, b) =>
                (workspaceOrderRef.current.get(a.cwd) ?? 0) -
                (workspaceOrderRef.current.get(b.cwd) ?? 0),
        );
        return groups;
    }, [props.workspaces, props.unread]);

    const channelItems = useMemo(
        () =>
            buildChannelConversationItems(
                props.conversations ?? [],
                props.workspaces,
                props.unread,
            ),
        [props.conversations, props.workspaces, props.unread],
    );
    const channelIds = useMemo(
        () => [...new Set((props.conversations ?? []).map((item) => item.channelId))].sort(),
        [props.conversations],
    );
    const visibleChannelItems = channelFilter
        ? channelItems.filter((item) => item.channelId === channelFilter)
        : channelItems;

    useEffect(() => {
        if (channelFilter && props.conversations && !channelIds.includes(channelFilter)) {
            setChannelFilter(null);
        }
    }, [channelFilter, channelIds, props.conversations]);

    useEffect(() => {
        if (props.mode !== "workspace") return;
        if (initializedModeRef.current === props.mode || workspaceGroups.length === 0) return;
        initializedModeRef.current = props.mode;
        if (props.expandedWorkspaces !== undefined) return;
        const preferred =
            workspaceGroups.find((group) => group.cwd === props.activeCwd) ?? workspaceGroups[0];
        if (preferred)
            setExpandedGroupKeys((current) => {
                if (current.has(preferred.key)) return current;
                return new Set(current).add(preferred.key);
            });
    }, [workspaceGroups, props.activeCwd, props.expandedWorkspaces, props.mode]);

    useEffect(() => {
        if (props.expandedWorkspaces === undefined) return;
        setExpandedGroupKeys(new Set(props.expandedWorkspaces.map((cwd) => `workspace:${cwd}`)));
    }, [props.expandedWorkspaces]);

    useEffect(() => {
        if (props.mode !== "workspace" || previousActiveCwdRef.current === props.activeCwd) return;
        previousActiveCwdRef.current = props.activeCwd;
        const activeGroup = workspaceGroups.find((group) => group.cwd === props.activeCwd);
        if (activeGroup) {
            setExpandedGroupKeys((current) => {
                if (current.has(activeGroup.key)) return current;
                return new Set(current).add(activeGroup.key);
            });
        }
    }, [workspaceGroups, props.activeCwd, props.mode]);

    const loadWorkspaceGroup = (group: WorkspaceConversationGroup): void => {
        setFailedGroups((current) => {
            if (!current.has(group.key)) return current;
            const next = new Set(current);
            next.delete(group.key);
            return next;
        });
        setLoadingGroups((current) => new Set(current).add(group.key));
        void props
            .onLoadWorkspace(group.cwd)
            .catch(() => setFailedGroups((current) => new Set(current).add(group.key)))
            .finally(() =>
                setLoadingGroups((current) => {
                    const next = new Set(current);
                    next.delete(group.key);
                    return next;
                }),
            );
    };

    const toggleGroup = (group: WorkspaceConversationGroup): void => {
        const open = expandedGroupKeys.has(group.key);
        const nextExpanded = new Set(expandedGroupKeys);
        if (open) nextExpanded.delete(group.key);
        else nextExpanded.add(group.key);
        setExpandedGroupKeys(nextExpanded);
        props.onExpandedWorkspacesChange?.(
            [...nextExpanded]
                .filter((key) => key.startsWith("workspace:"))
                .map((key) => key.slice("workspace:".length)),
        );
        if (open) return;
        const workspace = props.workspaces[group.cwd];
        if (workspace?.listTotal !== undefined) return;
        loadWorkspaceGroup(group);
    };

    const loadMoreGroup = async (group: WorkspaceConversationGroup): Promise<void> => {
        setFailedMoreGroups((current) => {
            if (!current.has(group.key)) return current;
            const next = new Set(current);
            next.delete(group.key);
            return next;
        });
        setLoadingMoreGroups((current) => new Set(current).add(group.key));
        try {
            const loaded = await props.onLoadMore(group.cwd);
            if (!loaded) setFailedMoreGroups((current) => new Set(current).add(group.key));
        } catch {
            setFailedMoreGroups((current) => new Set(current).add(group.key));
        } finally {
            setLoadingMoreGroups((current) => {
                const next = new Set(current);
                next.delete(group.key);
                return next;
            });
        }
    };

    const renderWorkspaceBody = (group: WorkspaceConversationGroup) => {
        const workspace = props.workspaces[group.cwd];
        const loading = loadingGroups.has(group.key);
        if (loading)
            return (
                <div className="conversation-group-empty">
                    <LoaderCircle size={13} className="spin" aria-hidden="true" />
                    {t("conversationNav.loading")}
                </div>
            );
        if (failedGroups.has(group.key))
            return (
                <div className="conversation-group-empty conversation-group-error">
                    <span>{t("conversationNav.loadFailed")}</span>
                    <button type="button" onClick={() => loadWorkspaceGroup(group)}>
                        {t("conversationNav.retry")}
                    </button>
                </div>
            );
        const search = props.searches.forWorkspace(group.cwd);
        const searching = search.query.trim() !== "";
        if ((!workspace || workspace.sessions.length === 0) && !searching)
            return (
                <div className="conversation-group-empty">
                    {t("conversationNav.noConversations")}
                </div>
            );
        return (
            <Sidebar
                embedded
                showHeader={false}
                activeSessionId={group.cwd === props.activeCwd ? workspace?.activeSession : null}
                ws={workspace}
                unread={props.unread}
                onAttach={(sessionId) => props.onOpenSession({ workspace: group.cwd, sessionId })}
                onDelete={(sessionId) => props.onDelete({ cwd: group.cwd, sessionId })}
                onRename={(sessionId) => props.onRename({ cwd: group.cwd, sessionId })}
                onLoadMore={() => void loadMoreGroup(group)}
                isLoadingMore={loadingMoreGroups.has(group.key)}
                loadMoreError={failedMoreGroups.has(group.key)}
                onNewSession={() => props.onNewSession(group.cwd)}
                newSessionDisabled={false}
                search={search}
            />
        );
    };

    const renderChannelList = () => {
        const refreshError = props.conversationsError ? (
            <div className="conversation-group-empty conversation-group-error" role="status">
                <span title={props.conversationsError}>{t("conversationNav.loadFailed")}</span>
                <button
                    type="button"
                    disabled={props.conversationsLoading}
                    onClick={props.onRetryConversations}
                >
                    {t("conversationNav.retry")}
                </button>
            </div>
        ) : null;
        if (refreshError && !props.conversations?.length) return refreshError;
        if (
            props.conversations === null ||
            (props.conversationsLoading && props.conversations.length === 0)
        )
            return (
                <div className="conversation-group-empty" role="status">
                    {t("conversationNav.loading")}
                </div>
            );
        if (!props.conversationsLoading && props.conversations?.length === 0)
            return (
                <div className="conversation-group-empty conversation-group-error">
                    <span>{t("workspaceMode.imNone")}</span>
                </div>
            );
        if (visibleChannelItems.length === 0)
            return (
                <div className="conversation-group-empty">
                    {t("conversationNav.noConversations")}
                </div>
            );
        const byKey = new Map(visibleChannelItems.map((item) => [item.cwd, item]));
        return (
            <>
                {refreshError}
                <SessionList
                    className="sidebar-list conversation-channel-list"
                    items={visibleChannelItems.map((item) => ({
                        key: item.cwd,
                        id: item.sessionId,
                        label: item.label,
                        title: `${item.channelId} / ${item.peerId} / ${item.chatId}`,
                        tag: item.channelId,
                        updatedAt: item.updatedAt,
                        running: item.running,
                        waiting: item.waiting,
                        incomplete: item.incomplete,
                        error: item.error,
                        unread: item.unread,
                        active: item.cwd === props.activeCwd,
                    }))}
                    onOpen={(row) => {
                        const item = byKey.get(row.key);
                        if (item)
                            props.onOpenSession({ workspace: item.cwd, sessionId: item.sessionId });
                    }}
                    onRename={(row) => {
                        const item = byKey.get(row.key);
                        if (item)
                            props.onRename({
                                cwd: item.cwd,
                                sessionId: item.sessionId,
                                currentName: item.label,
                            });
                    }}
                    onDelete={(row) => {
                        const item = byKey.get(row.key);
                        if (item) props.onDelete({ cwd: item.cwd, sessionId: item.sessionId });
                    }}
                    onManageAssociations={(row) => {
                        const item = byKey.get(row.key);
                        if (item) props.onManageAssociations?.({ workspace: item.cwd });
                    }}
                />
            </>
        );
    };

    const renderGroupStatus = (group: WorkspaceConversationGroup) => {
        const activity = summarizeConversationActivity(group.items);
        const statuses = (["waiting", "running", "error", "incomplete", "unread"] as const).filter(
            (status) => activity[status],
        );
        if (statuses.length === 0) return null;
        return (
            <span className="conversation-group-status">
                {statuses.map((status) => (
                    <span
                        className={`session-status-dot ${status}`}
                        role="img"
                        aria-label={t(`session.status.${status}`)}
                        title={t(`session.status.${status}`)}
                        key={status}
                    />
                ))}
            </span>
        );
    };

    return (
        <aside className="conversation-sidebar" aria-label={t("conversationNav.title")}>
            <div className="conversation-sidebar-header">
                <span className="conversation-sidebar-title">
                    {props.mode === "im" ? t("workspaceMode.im") : t("workspaceMode.workspace")}
                </span>
                <div className="conversation-sidebar-header-actions">
                    {props.mode === "im" && (
                        <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                                <button
                                    type="button"
                                    className={`conversation-sidebar-action${channelFilter ? " active" : ""}`}
                                    aria-label={t("conversationNav.filterByChannel")}
                                    title={t("conversationNav.filterByChannel")}
                                >
                                    <Filter size={14} aria-hidden="true" />
                                </button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                    className="ui-menu"
                                    align="end"
                                    sideOffset={4}
                                    collisionPadding={8}
                                >
                                    <DropdownMenu.RadioGroup
                                        value={channelFilter ?? ""}
                                        onValueChange={(value) => setChannelFilter(value || null)}
                                    >
                                        <DropdownMenu.RadioItem className="ui-menu-item" value="">
                                            <span className="ui-menu-label">
                                                {t("conversationNav.allChannels")}
                                            </span>
                                            {!channelFilter && (
                                                <Check size={14} aria-hidden="true" />
                                            )}
                                        </DropdownMenu.RadioItem>
                                        {channelIds.map((channelId) => (
                                            <DropdownMenu.RadioItem
                                                className="ui-menu-item"
                                                value={channelId}
                                                key={channelId}
                                            >
                                                <span className="ui-menu-label">{channelId}</span>
                                                {channelFilter === channelId && (
                                                    <Check size={14} aria-hidden="true" />
                                                )}
                                            </DropdownMenu.RadioItem>
                                        ))}
                                    </DropdownMenu.RadioGroup>
                                </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                    )}
                    {props.mode === "workspace" && props.onOpenFolder && (
                        <button
                            type="button"
                            className="conversation-sidebar-action"
                            aria-label={t("conversationNav.openFolder")}
                            title={t("conversationNav.openFolder")}
                            onClick={props.onOpenFolder}
                        >
                            <FolderPlus size={14} aria-hidden="true" />
                        </button>
                    )}
                    {props.mode === "im" && (
                        <button
                            type="button"
                            className="conversation-sidebar-action"
                            aria-label={t("conversationNav.manageChannels")}
                            title={t("conversationNav.manageChannels")}
                            onClick={props.onManageChannels}
                        >
                            <Settings2 size={14} aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>
            <div className="conversation-sidebar-scroll">
                {props.mode === "im"
                    ? renderChannelList()
                    : workspaceGroups.map((group) => {
                          const isExpanded = expandedGroupKeys.has(group.key);
                          const workspace = props.workspaces[group.cwd];
                          const search = props.searches.forWorkspace(group.cwd);
                          const workspaceHasRecords =
                              workspace !== undefined &&
                              (workspace.listTotal ?? workspace.sessions.length) > 0;
                          return (
                              <section
                                  className={`conversation-group${isExpanded ? " expanded" : ""}`}
                                  key={group.key}
                                  aria-label={group.label}
                              >
                                  <div className="conversation-group-header">
                                      <button
                                          type="button"
                                          className="conversation-group-toggle"
                                          aria-expanded={isExpanded}
                                          aria-label={`${isExpanded ? t("conversationNav.collapseGroup") : t("conversationNav.expandGroup")} ${group.label}`}
                                          onClick={() => toggleGroup(group)}
                                      >
                                          {isExpanded ? (
                                              <ChevronDown size={13} aria-hidden="true" />
                                          ) : (
                                              <ChevronRight size={13} aria-hidden="true" />
                                          )}
                                          <Folder size={13} aria-hidden="true" />
                                          <span className="conversation-group-label">
                                              {group.label}
                                          </span>
                                          {renderGroupStatus(group)}
                                      </button>
                                      {isExpanded && (
                                          <div className="conversation-group-actions">
                                              <button
                                                  type="button"
                                                  className="conversation-sidebar-action"
                                                  aria-label={t("session.newChat")}
                                                  title={t("session.newChat")}
                                                  onClick={() => props.onNewSession(group.cwd)}
                                              >
                                                  <Plus size={13} aria-hidden="true" />
                                              </button>
                                              {workspaceHasRecords && (
                                                  <button
                                                      type="button"
                                                      className={`conversation-sidebar-action${searchVisible(group.cwd) ? " active" : ""}`}
                                                      aria-label={t("pane.searchLabel")}
                                                      aria-expanded={searchVisible(group.cwd)}
                                                      onClick={() => {
                                                          if (searchVisible(group.cwd)) {
                                                              search.setQuery("");
                                                              setOpenSearches((current) => {
                                                                  const next = new Set(current);
                                                                  next.delete(group.cwd);
                                                                  return next;
                                                              });
                                                          } else {
                                                              pendingSearchFocusRef.current =
                                                                  group.cwd;
                                                              setOpenSearches((current) =>
                                                                  new Set(current).add(group.cwd),
                                                              );
                                                          }
                                                      }}
                                                  >
                                                      <Search size={13} aria-hidden="true" />
                                                  </button>
                                              )}
                                              {props.onManageAssociations && (
                                                  <button
                                                      type="button"
                                                      className="conversation-sidebar-action"
                                                      aria-label={t("activity.manageAssociations")}
                                                      title={t("activity.manageAssociations")}
                                                      onClick={() =>
                                                          props.onManageAssociations?.({
                                                              workspace: group.cwd,
                                                          })
                                                      }
                                                  >
                                                      <Link2 size={13} aria-hidden="true" />
                                                  </button>
                                              )}
                                          </div>
                                      )}
                                  </div>
                                  {isExpanded && (
                                      <div className="conversation-group-body">
                                          {searchVisible(group.cwd) && (
                                              <div className="conversation-sidebar-search">
                                                  <input
                                                      ref={(node) => {
                                                          const refs = searchInputRefs.current;
                                                          if (node) refs.set(group.cwd, node);
                                                          else refs.delete(group.cwd);
                                                      }}
                                                      className="conversation-sidebar-search-input"
                                                      value={search.query}
                                                      onChange={(e) =>
                                                          search.setQuery(e.target.value)
                                                      }
                                                      onKeyDown={(e) => {
                                                          if (e.key === "Escape") {
                                                              search.setQuery("");
                                                              setOpenSearches((current) => {
                                                                  const next = new Set(current);
                                                                  next.delete(group.cwd);
                                                                  return next;
                                                              });
                                                          }
                                                      }}
                                                      placeholder={t("pane.searchPlaceholder")}
                                                      aria-label={t("pane.searchLabel")}
                                                  />
                                              </div>
                                          )}
                                          {renderWorkspaceBody(group)}
                                      </div>
                                  )}
                              </section>
                          );
                      })}
                {props.mode === "workspace" && workspaceGroups.length === 0 && (
                    <div className="conversation-group-empty">
                        <span>{t("conversationNav.noWorkspaces")}</span>
                        {props.onOpenFolder && (
                            <button type="button" onClick={props.onOpenFolder}>
                                {t("conversationNav.openFolder")}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </aside>
    );
}
