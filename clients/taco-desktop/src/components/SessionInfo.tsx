/**
 * SessionInfo — top-of-ChatPane session info bar. Left to right: session-list
 * toggle, new-chat button, divider, then id (short) / copy / log / status /
 * creation time, with the task panel and file-tree toggles pinned right.
 *
 * The toggle and new-chat button are the row's two primary actions and share
 * an accent-chip style (.session-info-toggle / .session-info-new); copy, log,
 * tasks and files are plain icon buttons clustered with negative margins.
 * "Open log" sits next to the copy button as a session-level action.
 *
 * "Open folder…" (the workspace picker entry that switches the active
 * workspace to a directory the user chooses) deliberately stays inside the
 * WorkspacePicker dropdown menu rather than on this row — it is a
 * workspace-level action, not a session-level one, and the dropdown is its
 * natural home.
 */

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    FileText,
    FolderTree,
    ListTodo,
    Plus,
} from "lucide-react";
import type { WorkspaceState } from "../hooks/useWorkspaces";
import { useT } from "../i18n/useI18n";

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
    /** Start a new session — same action as the topbar "new chat" chip. */
    onNewSession?: () => void;
    newSessionDisabled?: boolean;
    /** IM conversations have no filesystem; suppress the file-tree button only. */
    isIm?: boolean;
}) {
    const { t } = useT();
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
    if (!activeId) {
        return (
            <div className="session-info empty">
                {toggle}
                {t("session.noActiveSession")}
            </div>
        );
    }
    const statusKey = isRunning ? "session.status.running" : "session.status.idle";
    const filePath = activeMeta?.filePath;
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
            {/* Short id saves horizontal space; hover shows full id; copy uses the full value. */}
            <code className="session-info-id" title={activeId}>
                {activeId.slice(0, 8)}
            </code>
            <button
                className="session-info-copy"
                title={t("session.copySessionId")}
                aria-label={t("session.copySessionId")}
                onClick={() => onCopy(activeId)}
            >
                {copiedSessionId === activeId ? (
                    <Check size={13} aria-hidden="true" />
                ) : (
                    <Copy size={13} aria-hidden="true" />
                )}
            </button>
            {filePath && (
                <button
                    type="button"
                    className="session-info-log"
                    title={`${filePath}\n${t("session.openLog")}`}
                    aria-label={`${t("session.openLog")}: ${filePath}`}
                    onClick={async () => {
                        // Try system default app first; fall back to revealing in file manager.
                        try {
                            await openPath(filePath);
                        } catch {
                            try {
                                await revealItemInDir(filePath);
                            } catch (err) {
                                console.error("[taco] open log file failed", err);
                            }
                        }
                    }}
                >
                    <FileText size={14} aria-hidden="true" />
                </button>
            )}
            <span className={`session-info-status ${isRunning ? "running" : "idle"}`}>
                {t(statusKey)}
            </span>
            {activeMeta?.createdAt && (
                <span className="session-info-time">
                    {t("session.createdAtLabel")} {new Date(activeMeta.createdAt).toLocaleString()}
                </span>
            )}
            {filePath && <span className="session-info-divider" aria-hidden="true" />}
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
            {onToggleFiles && !isIm && (
                // File-tree drawer toggle. Suppressed for IM conversations
                // (no filesystem to browse). aria-pressed mirrors tasks so the
                // two right-side icons visually track their panel state.
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
            )}
        </div>
    );
}
