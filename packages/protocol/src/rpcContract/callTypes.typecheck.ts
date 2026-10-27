/** Compile-only contract assertions, checked by typecheck:protocol; not runtime tests. */

import { asSessionId, asWorkspaceId } from "../frames.js";
import { createRpcRequest, type ProcessScopedKey, RPC, type WorkspaceScopedKey } from "./index.js";

// Positive cases ensure the scope filters never silently collapse to never.
const workspaceKey: WorkspaceScopedKey = "sessionCreate";
const processKey: ProcessScopedKey = "settingsGet";
// @ts-expect-error process methods must not route as workspace methods
const wrongWorkspace: WorkspaceScopedKey = "settingsGet";
// @ts-expect-error workspace methods must not route as process methods
const wrongProcess: ProcessScopedKey = "sessionCreate";
void [workspaceKey, processKey, wrongWorkspace, wrongProcess];

// These calls are typechecked, never executed by a test runner.
function checkRequests() {
    const workspace = asWorkspaceId("/w");
    createRpcRequest("1", RPC.sessionCreate, { workspace });
    createRpcRequest("2", RPC.workspaceList, undefined);
    // @ts-expect-error create requires a workspace
    createRpcRequest("3", RPC.sessionCreate, {});
    // @ts-expect-error method must be a known wire name
    createRpcRequest("4", "session.creat", { workspace });
    // @ts-expect-error history requires a session id
    createRpcRequest("5", RPC.sessionHistory, { workspace });
    createRpcRequest("6", RPC.sessionHistory, { workspace, sessionId: asSessionId("s") });
}
void checkRequests;
