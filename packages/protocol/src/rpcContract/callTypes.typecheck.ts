/** Compile-only contract assertions, checked by typecheck:protocol; not runtime tests. */

import { asSessionId, asWorkspaceId } from "../frames.js";
import type {
    WorkspaceAssociationsGetParams,
    WorkspaceAssociationsResolveParams,
    WorkspaceAssociationsSetParams,
} from "../workspace.js";
import { createRpcRequest, type ProcessScopedKey, RPC, type WorkspaceScopedKey } from "./index.js";
import type { ParamsLacksShape } from "./types.js";

// `Type.Any` and `Type.Unknown` must both trip the untyped-params guard;
// valid no-param and concrete shapes must not.
// biome-ignore lint/suspicious/noExplicitAny: the guard must cover Type.Any as well as Type.Unknown.
const anyIsUntyped: ParamsLacksShape<any> = true;
const unknownIsUntyped: ParamsLacksShape<unknown> = true;
const undefinedIsTyped: ParamsLacksShape<undefined> = false;
const objectIsTyped: ParamsLacksShape<{ id: string }> = false;
const arrayIsTyped: ParamsLacksShape<readonly string[]> = false;
void [anyIsUntyped, unknownIsUntyped, undefinedIsTyped, objectIsTyped, arrayIsTyped];

// Workspace association DTOs keep their public readonly modifiers even
// though their shapes are derived from TypeBox schemas.
function checkAssociationReadonly(
    get: WorkspaceAssociationsGetParams,
    set: WorkspaceAssociationsSetParams,
    resolve: WorkspaceAssociationsResolveParams,
) {
    // @ts-expect-error the key property is readonly
    get.key = { scope: "workspace", id: "other" };
    // @ts-expect-error the nested id is readonly
    get.key.id = "other";
    // @ts-expect-error the roots property is readonly
    set.roots = [];
    // @ts-expect-error the roots array itself is readonly
    set.roots.push("/other");
    // @ts-expect-error the workspace property is readonly
    resolve.workspace = asWorkspaceId("/other");
}
void checkAssociationReadonly;

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
