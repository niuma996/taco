/**
 * PendingPermissionsModal — shell approvals still awaiting a decision, across
 * every open workspace.
 *
 * The tool card is not a reliable surface for these. A background spawn's card
 * reports `ok` from the moment it launches, and the user usually leaves the
 * session that spawned it long before the child asks to run something — so the
 * request would otherwise sit invisible until the broker times it out. The
 * same holds across workspaces: an IM chat or another project can block while
 * the user is looking elsewhere, so the list is not scoped to the active one.
 */

import type { CommandPermissionRequest, CommandPermissionScope } from "@taco-ai/protocol";
import { IM_CWD_PREFIX, parseImCwd } from "@taco-ai/protocol";
import { useT } from "../i18n/useI18n";
import type { WorkspaceState } from "../lib/chat/workspaceReducer";
import { lastSegment } from "../lib/workspaceStorage";
import { CommandPermissionPrompt } from "./CommandPermissionPrompt";
import { Modal } from "./ui/Modal";

export interface PendingPermissionEntry {
    cwd: string;
    request: CommandPermissionRequest;
}

/** Flatten every workspace's pending table; resolution must target `cwd`. */
export function collectPendingPermissions(
    workspaces: Readonly<Record<string, WorkspaceState>>,
): PendingPermissionEntry[] {
    return Object.values(workspaces).flatMap((ws) =>
        Object.values(ws.pendingCommandPermissions).map((request) => ({ cwd: ws.cwd, request })),
    );
}

export function PendingPermissionsModal({
    open,
    onClose,
    workspaces,
    onResolve,
}: {
    open: boolean;
    onClose: () => void;
    workspaces: Readonly<Record<string, WorkspaceState>>;
    onResolve: (
        cwd: string,
        requestId: string,
        approved: boolean,
        scope: CommandPermissionScope,
    ) => void;
}) {
    const { t } = useT();
    const entries = collectPendingPermissions(workspaces);
    return (
        <Modal
            open={open}
            onClose={onClose}
            title={t("session.pendingPermissions")}
            className="pending-permissions-modal"
        >
            {entries.length === 0 ? (
                <p className="pending-permissions-empty">{t("session.pendingPermissionsEmpty")}</p>
            ) : (
                <ul className="pending-permissions-list">
                    {entries.map(({ cwd, request }) => (
                        <li key={`${cwd}\u0000${request.requestId}`}>
                            <CommandPermissionPrompt
                                request={request}
                                onResolve={(requestId, approved, scope) =>
                                    onResolve(cwd, requestId, approved, scope)
                                }
                                className="pending-permission"
                            >
                                {/* A subagent's approval blocks that child, not the
                                    visible session, and it may live in another
                                    workspace. Always name both origins. */}
                                <div className="pending-permission-source">
                                    {t("session.pendingPermissionsFrom")}: {workspaceLabel(cwd)} ·{" "}
                                    {sessionLabel(request, workspaces[cwd])}
                                </div>
                            </CommandPermissionPrompt>
                        </li>
                    ))}
                </ul>
            )}
        </Modal>
    );
}

function workspaceLabel(cwd: string): string {
    if (!cwd.startsWith(IM_CWD_PREFIX)) return lastSegment(cwd);
    return parseImCwd(cwd)?.channelId ?? cwd;
}

function sessionLabel(request: CommandPermissionRequest, ws: WorkspaceState | undefined): string {
    const sessionId = request.displaySessionId ?? request.sessionId;
    return ws?.sessions.find((session) => session.id === sessionId)?.name ?? sessionId.slice(0, 8);
}
