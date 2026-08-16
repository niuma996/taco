/**
 * SessionInfo — top-of-ChatPane session info bar: sidebar toggle on the left,
 * then id (short) / copy / log / file-tree / status / creation time.
 *
 * "Open log" and "toggle file tree" live on this row on purpose. They used
 * to be in two different topbar locations, and the file-tree button
 * overlapped the custom window chrome on the frameless Windows build.
 * Grouping them keeps every session-level action one click away from the
 * active session without crowding the topbar.
 *
 * "Open folder…" (the workspace picker entry that switches the active
 * workspace to a directory the user chooses) deliberately stays inside the
 * WorkspacePicker dropdown menu rather than on this row — it is a
 * workspace-level action, not a session-level one, and the dropdown is its
 * natural home.
 */

import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Check, ChevronsLeft, ChevronsRight, Copy, FileText, FolderTree } from "lucide-react";
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
    /** IM conversations have no filesystem; suppress the file-tree button only. */
    isIm?: boolean;
}) {
    const { t } = useT();
    const activeId = ws?.activeSession;
    const activeMeta = activeId ? ws?.sessions.find((s) => s.id === activeId) : undefined;
    const isRunning = Boolean(ws?.pendingBySessionId[activeId ?? ""]);
    const toggle = (
        <button
            type="button"
            className="session-info-toggle"
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? t("activity.expand") : t("activity.collapse")}
            aria-label={sidebarCollapsed ? t("activity.expand") : t("activity.collapse")}
            aria-expanded={!sidebarCollapsed}
        >
            {sidebarCollapsed ? (
                <ChevronsRight size={14} aria-hidden="true" />
            ) : (
                <ChevronsLeft size={14} aria-hidden="true" />
            )}
        </button>
    );
    if (!activeId) {
        return (
            <div className="session-info empty">
                {toggle}
                No active session. Create one or pick one from the left.
            </div>
        );
    }
    const statusKey = isRunning ? "session.status.running" : "session.status.idle";
    const filePath = activeMeta?.filePath;
    return (
        <div className="session-info">
            {toggle}
            <span className="session-info-label">{t("app.session")}</span>
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
            <span className={`session-info-status ${isRunning ? "running" : "idle"}`}>
                {t(statusKey)}
            </span>
            {activeMeta?.createdAt && (
                <span className="session-info-time">
                    {t("session.createdAtLabel")} {new Date(activeMeta.createdAt).toLocaleString()}
                </span>
            )}
            {filePath && <span className="session-info-divider" aria-hidden="true" />}
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
            {onToggleFiles && !isIm && (
                // File-tree drawer toggle. The topbar's FolderTree button moved
                // here to clear the overlap with the frameless window controls.
                // Suppressed for IM conversations (no filesystem to browse).
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
