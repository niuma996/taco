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
                                sessionName={
                                    sessions.find(
                                        (s) =>
                                            s.id ===
                                            (request.displaySessionId ?? request.sessionId),
                                    )?.name
                                }
                                onResolve={onResolve}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </Modal>
    );
}

function PermissionRow({
    request,
    sessionName,
    onResolve,
}: {
    request: CommandPermissionRequest;
    sessionName: string | undefined;
    onResolve: (requestId: string, approved: boolean, scope: CommandPermissionScope) => void;
}) {
    const { t } = useT();
    return (
        <CommandPermissionPrompt
            request={request}
            onResolve={onResolve}
            className="pending-permission"
        >
            {/* A subagent's approval blocks that child, not the visible session —
                naming the origin is what makes a cross-session row readable. */}
            {sessionName && (
                <div className="pending-permission-source">
                    {t("session.pendingPermissionsFrom")}: {sessionName}
                </div>
            )}
        </CommandPermissionPrompt>
    );
}
