import type {
    CommandPermissionDecision,
    CommandPermissionRequest,
    SessionId,
    WorkspaceId,
} from "@taco-ai/protocol";
import { PushMethods } from "@taco-ai/protocol";
import type { PermissionBroker } from "../permissions/permissionBroker.ts";
import type { WorkService } from "../work/workService.ts";
import { redactCommandPermissionRequest } from "./push.ts";

type PermissionNotice = "requested" | "approved" | "timeout" | "denied";
type PermissionMethod =
    | typeof PushMethods.CommandPermissionRequested
    | typeof PushMethods.CommandPermissionResolved;

/** Keep the broker, live Work projection and UI pushes on the same requested/resolved lifecycle. */
export function wirePermissionPush(args: {
    broker: PermissionBroker;
    workspace: WorkspaceId;
    work: Pick<WorkService, "permissionRequested" | "permissionResolved">;
    push: (method: PermissionMethod, sessionId: SessionId, params: Record<string, unknown>) => void;
    notice: (kind: PermissionNotice, sessionId: SessionId) => string;
}): () => void {
    const requested = (request: CommandPermissionRequest): void => {
        args.work.permissionRequested(args.workspace, request);
        const [redacted] = redactCommandPermissionRequest(request);
        const session = request.displaySessionId ?? request.sessionId;
        args.push(PushMethods.CommandPermissionRequested, session, {
            ...redacted,
            text: args.notice("requested", session),
        });
    };
    const resolved = ({
        request,
        decision,
    }: {
        request: CommandPermissionRequest;
        decision: CommandPermissionDecision;
    }): void => {
        args.work.permissionResolved(args.workspace, request.requestId);
        const session = request.displaySessionId ?? request.sessionId;
        args.push(PushMethods.CommandPermissionResolved, session, {
            requestId: request.requestId,
            approved: decision.approved,
            ...(decision.denialReason ? { denialReason: decision.denialReason } : {}),
            text: args.notice(
                decision.approved
                    ? "approved"
                    : decision.denialReason === "timeout"
                      ? "timeout"
                      : "denied",
                session,
            ),
        });
    };
    args.broker.on("requested", requested);
    args.broker.on("resolved", resolved);
    return () => {
        args.broker.off("requested", requested);
        args.broker.off("resolved", resolved);
    };
}
