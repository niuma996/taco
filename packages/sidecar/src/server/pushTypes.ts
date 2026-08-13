/**
 * Shared push adapter types.
 *
 * Adapters translate internal runtime events into named push frames without
 * directly depending on stdout or the server. SidecarServer injects `emitPush`
 * so it keeps control over serialization and session-kind routing.
 */

import type { PushMethodName, PushParams, SessionId, WorkspaceId } from "@taco-ai/protocol";

/** EmitPushFn signature — injected by SidecarServer. */
export type EmitPushFn = <M extends PushMethodName>(
    method: M,
    workspace: WorkspaceId,
    session: SessionId,
    params: PushParams<M>,
) => void;
