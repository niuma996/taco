/**
 * Shared guard for handlers that require an attached session.
 */

import type { AttachParams } from "@taco-ai/protocol";
import { ErrorCodes } from "@taco-ai/protocol";

import type { AttachedSession } from "../../runtime/attachedSession.ts";
import type { AttachOptions, WorkspaceRuntime } from "../../runtime/workspace.ts";
import { RpcHandlerError } from "../methodRegistry.ts";

/** Resolve attached session or throw invalid_state. */
export function requireAttached(
    workspace: WorkspaceRuntime,
    sessionId: AttachParams["sessionId"],
): AttachedSession {
    const attached = workspace.getAttached(sessionId);
    if (!attached) {
        throw new RpcHandlerError(
            ErrorCodes.InvalidState,
            "session not attached; call session.attach first",
        );
    }
    return attached;
}

/** Auto-attach if not already attached; used by pull-side handlers. */
export async function ensureAttached(
    workspace: WorkspaceRuntime,
    sessionId: AttachParams["sessionId"],
    opts?: AttachOptions,
): Promise<AttachedSession> {
    let attached = workspace.getAttached(sessionId);
    if (!attached) attached = await workspace.attach(sessionId, opts);
    return attached;
}
