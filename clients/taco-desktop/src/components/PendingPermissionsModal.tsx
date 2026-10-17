/**
 * PendingPermissionsModal — workspace-scoped list of shell approvals still
 * awaiting a decision.
 *
 * The tool card is not a reliable surface for these. A background spawn's card
 * reports `ok` from the moment it launches, and the user usually leaves the
 * session that spawned it long before the child asks to run something — so the
 * request would otherwise sit invisible until the broker times it out. This
 * modal reads the workspace-level pending table, which survives session
 * switches, and is reachable from any session in the workspace.
 */

import type { CommandPermissionRequest, CommandPermissionScope } from "@taco-ai/protocol";
import { useT } from "../i18n/useI18n";
import type { SessionMeta } from "../lib/chat/workspaceReducer";
import { CommandPermissionPrompt } from "./CommandPermissionPrompt";
import { Modal } from "./ui/Modal";

export function PendingPermissionsModal({
    open,
    onClose,
    requests,
    sessions,
    onResolve,
}: {
    open: boolean;
    onClose: () => void;
    /** requestId → request, straight from the workspace pending table. */
    requests: Readonly<Record<string, CommandPermissionRequest>>;
    /** For naming the originating session — an approval from another session is
     *  the normal case here, not an edge case. */
    sessions: readonly SessionMeta[];
    onResolve: (requestId: string, approved: boolean, scope: CommandPermissionScope) => void;
}) {
    const { t } = useT();
    const entries = Object.values(requests);
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
                    {entries.map((request) => (
                        <li key={request.requestId}>
                            <PermissionRow
                                request={request}
                                sessionLabel={sessionLabel(request, sessions)}
                                onResolve={onResolve}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </Modal>
    );
}

function sessionLabel(request: CommandPermissionRequest, sessions: readonly SessionMeta[]): string {
    const sessionId = request.displaySessionId ?? request.sessionId;
    return sessions.find((session) => session.id === sessionId)?.name ?? sessionId.slice(0, 8);
}

function PermissionRow({
    request,
    sessionLabel,
    onResolve,
}: {
    request: CommandPermissionRequest;
    sessionLabel: string;
    onResolve: (requestId: string, approved: boolean, scope: CommandPermissionScope) => void;
}) {
    const { t } = useT();
    return (
        <CommandPermissionPrompt
            request={request}
            onResolve={onResolve}
            className="pending-permission"
        >
            {/* A subagent's approval blocks that child, not the visible session.
                Always name the origin; unnamed sessions fall back to a short id. */}
            <div className="pending-permission-source">
                {t("session.pendingPermissionsFrom")}: {sessionLabel}
            </div>
        </CommandPermissionPrompt>
    );
}
