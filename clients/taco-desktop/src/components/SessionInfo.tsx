/**
 * SessionInfo — top-of-ChatPane session info bar. Left to right: session-list
 * toggle, new-chat button, divider, then status and title (truncating), with
 * the session details icon (full id + copy / created-at / open log) and the
 * task panel and file-tree toggles pinned right.
 *
 * The toggle and new-chat button are the row's two primary actions and share
 * an accent-chip style (.session-info-toggle / .session-info-new); copy, log,
 * tasks and files are plain icon buttons clustered with negative margins.
 * Copy / log / created-at are consolidated behind one details icon so the bar
 * never carries more than one metadata line.
 *
 * "Open folder…" (the workspace picker entry that switches the active
 * workspace to a directory the user chooses) deliberately stays inside the
 * WorkspacePicker dropdown menu rather than on this row — it is a
 * workspace-level action, not a session-level one, and the dropdown is its
 * natural home.
 */

import * as Popover from "@radix-ui/react-popover";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    FileText,
    FolderTree,
    Info,
    ListTodo,
    Plus,
    UsersRoundCollaboration,
} from "lucide-react";
import { useNow } from "../hooks/useNow";
import type { WorkspaceState } from "../hooks/useWorkspaces";
import { useT, useUiLanguage } from "../i18n/useI18n";
import { formatRelativeTime } from "../lib/relativeTime";
import { IconButton } from "./ui/IconButton";

export function SessionInfo({
    ws,
    onCopy,
    copiedSessionId,
    sidebarCollapsed,
    onToggleSidebar,
    onToggleFiles,
    filesOpen,
    onToggleTasks,
    tasksOpen,
    onToggleSubagents,
    subagentsOpen,
    subagentDot,
    onNewSession,
    newSessionDisabled,
    isIm,
}: {
    ws: WorkspaceState | undefined;
    onCopy: (sid: string) => void;
    copiedSessionId: string | null;
    sidebarCollapsed: boolean;
    onToggleSidebar: () => void;
    /** Show / hide the file-tree drawer. */
    onToggleFiles?: () => void;
    filesOpen?: boolean;
    /** Show / hide the task panel. */
    onToggleTasks?: () => void;
    tasksOpen?: boolean;
    /** Show / hide the subagent panel. */
    onToggleSubagents?: () => void;
    subagentsOpen?: boolean;
    /** none = hide the dot, idle = all terminal, active = at least one running. */
    subagentDot?: "none" | "idle" | "active";
    /** Start a new session — same action as the topbar "new chat" chip. */
    onNewSession?: () => void;
    newSessionDisabled?: boolean;
    /** IM conversations have no filesystem; suppress the file-tree button only. */
    isIm?: boolean;
}) {
    const { t } = useT();
    const lng = useUiLanguage();
    const nowMs = useNow();
    const activeId = ws?.activeSession;
    const activeMeta = activeId ? ws?.sessions.find((s) => s.id === activeId) : undefined;
    const isRunning = Boolean(ws?.pendingBySessionId[activeId ?? ""]);
    // Task-awareness dot on the task-panel button (panel closed only):
    // accent while any task is unfinished (pending / in_progress), dim when
    // the session has task artifacts but all are terminal — the sidecar moves
    // fully-finished lists into history, so "active" alone can't see them.
    const taskSnapshot = activeId ? ws?.taskSnapshotsBySessionId[activeId] : undefined;
    const hasUnfinishedTasks = Boolean(
        taskSnapshot?.active?.tasks.some(
            (task) => task.status === "pending" || task.status === "in_progress",
        ),
    );
    const hasAnyTasks = Boolean(
        taskSnapshot && (taskSnapshot.active || taskSnapshot.history.length),
    );
    // Fixed label "聊天列表" with a direction chevron on its left — a bare
    // icon here was too easy to misread ("is this a pager?"), and a label
    // that flips between 展开/收起 changed width on every toggle. Fixed text
    // + stateful icon keeps the button stable and self-explanatory.
    const toggle = (
        <button
            type="button"
            className="session-info-toggle"
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? t("session.sidebarShow") : t("session.sidebarHide")}
            aria-label={sidebarCollapsed ? t("session.sidebarShow") : t("session.sidebarHide")}
            aria-expanded={!sidebarCollapsed}
        >
            {sidebarCollapsed ? (
                <ChevronRight size={14} aria-hidden="true" />
            ) : (
                <ChevronLeft size={14} aria-hidden="true" />
            )}
            <span>{t("session.sidebarLabel")}</span>
        </button>
    );
    // File-tree drawer toggle. Suppressed for IM conversations (no filesystem
    // to browse). Independent of session state — it browses the workspace, so
    // it also renders in the no-active-session (new chat) state. aria-pressed
    // mirrors tasks so the two right-side icons track their panel state.
    const filesButton = onToggleFiles && !isIm && (
        <button
            type="button"
            className="session-info-files"
            title={t("files.buttonLabel")}
            aria-label={t("files.buttonLabel")}
            aria-pressed={filesOpen ?? false}
            onClick={() => onToggleFiles()}
        >
            <FolderTree size={14} aria-hidden="true" />
        </button>
    );
    if (!activeId) {
        return (
            <div className="session-info empty">
                {toggle}
                {t("session.noActiveSession")}
                {filesButton}
            </div>
        );
    }
    const statusKey = isRunning ? "session.status.running" : "session.status.idle";
    const filePath = activeMeta?.filePath;
    const openLog = async () => {
        // Try system default app first; fall back to revealing in file manager.
        try {
            await openPath(filePath ?? "");
        } catch {
            try {
                await revealItemInDir(filePath ?? "");
            } catch (err) {
                console.error("[taco] open log file failed", err);
            }
        }
    };
    return (
        <div className="session-info">
            {toggle}
            {onNewSession && (
                // Same action as the topbar "new chat" chip, duplicated here so
                // it's reachable without moving the cursor to the topbar.
                <button
                    type="button"
                    className="session-info-new"
                    onClick={onNewSession}
                    disabled={newSessionDisabled}
                    title={t("session.newInWorkspace")}
                    aria-label={t("session.newInWorkspace")}
                >
                    <Plus size={14} aria-hidden="true" />
                    <span>{t("session.new")}</span>
                </button>
            )}
            <span className="session-info-divider" aria-hidden="true" />
            {/* Status leads the metadata block: the dot reads as the session's
                live signal before its name. Never shrinks — the title
                truncates instead. */}
            <span className={`session-info-status ${isRunning ? "running" : "idle"}`}>
                <span className="session-status-dot" aria-hidden="true" />
                {t(statusKey)}
            </span>
            {/* Title is the bar's primary identifier: it grows into the free
                width and truncates with an ellipsis. Unnamed sessions fall
                back to the short id. */}
            {activeMeta?.name ? (
                <span className="session-info-title" title={activeMeta.name}>
                    {activeMeta.name}
                </span>
            ) : (
                <code className="session-info-id" title={activeId}>
                    {activeId.slice(0, 8)}
                </code>
            )}
            {/* Full id + copy / created-at / open log consolidated behind one
                icon. margin-left:auto fills the slot the created-time text used
                to hold: metadata stays left, the action cluster stays right. */}
            <Popover.Root>
                <Popover.Trigger asChild>
                    <button
                        type="button"
                        className="session-info-details"
                        title={t("session.details")}
                        aria-label={t("session.details")}
                    >
                        <Info size={14} aria-hidden="true" />
                    </button>
                </Popover.Trigger>
                <Popover.Portal>
                    {/* The bar sits on the window's top edge, so "bottom" is the
                        only side with room — same placement as the notification bell. */}
                    <Popover.Content
                        className="session-info-popover"
                        side="bottom"
                        sideOffset={6}
                        align="end"
                        collisionPadding={8}
                    >
                        {/* Key-value rows: dim label on a fixed-width left column,
                            content after it — same grid for every row so the
                            popover reads as one table, not mixed styles. */}
                        <div className="session-info-popover__row">
                            <span className="session-info-popover__label">
                                {t("session.idLabel")}
                            </span>
                            <code className="session-info-popover__id" title={activeId}>
                                {activeId}
                            </code>
                            <IconButton
                                size="sm"
                                aria-label={t("session.copySessionId")}
                                data-state={copiedSessionId === activeId ? "copied" : undefined}
                                onClick={() => onCopy(activeId)}
                            >
                                {copiedSessionId === activeId ? (
                                    <Check size={13} aria-hidden="true" />
                                ) : (
                                    <Copy size={13} aria-hidden="true" />
                                )}
                            </IconButton>
                        </div>
                        {activeMeta?.createdAt && (
                            <div className="session-info-popover__row">
                                <span className="session-info-popover__label">
                                    {t("session.createdAtLabel")}
                                </span>
                                <span className="session-info-popover__value">
                                    {formatRelativeTime(activeMeta.createdAt, lng, nowMs)}
                                </span>
                            </div>
                        )}
                        {filePath && (
                            <div className="session-info-popover__row">
                                <span className="session-info-popover__label">
                                    {t("session.logLabel")}
                                </span>
                                <button
                                    type="button"
                                    className="session-info-popover__log"
                                    title={filePath}
                                    onClick={() => void openLog()}
                                >
                                    <FileText size={13} aria-hidden="true" />
                                    {t("session.openLog")}
                                </button>
                            </div>
                        )}
                    </Popover.Content>
                </Popover.Portal>
            </Popover.Root>
            {(onToggleSubagents || onToggleTasks || filesButton) && (
                <span className="session-info-divider" aria-hidden="true" />
            )}
            {onToggleSubagents && (
                <button
                    type="button"
                    className="session-info-subagents"
                    title={t("session.subagentPanel")}
                    aria-label={t("session.subagentPanel")}
                    aria-pressed={subagentsOpen ?? false}
                    onClick={onToggleSubagents}
                >
                    <UsersRoundCollaboration size={14} aria-hidden="true" />
                    {subagentDot !== undefined && subagentDot !== "none" && !subagentsOpen && (
                        <span
                            className={`session-info-tasks-dot${subagentDot === "active" ? " session-info-tasks-dot--active" : ""}`}
                            aria-hidden="true"
                        />
                    )}
                </button>
            )}
            {onToggleTasks && (
                <button
                    type="button"
                    className="session-info-tasks"
                    title={t("session.taskPanel")}
                    aria-label={t("session.taskPanel")}
                    aria-pressed={tasksOpen ?? false}
                    onClick={onToggleTasks}
                >
                    <ListTodo size={14} aria-hidden="true" />
                    {hasAnyTasks && !tasksOpen && (
                        <span
                            className={`session-info-tasks-dot${hasUnfinishedTasks ? " session-info-tasks-dot--active" : ""}`}
                            aria-hidden="true"
                        />
                    )}
                </button>
            )}
            {filesButton}
        </div>
    );
}
