/**
 * commandPermission.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/commandPermission.ts`.
 *
 * The schema validates the envelope before dispatch; the handler still owns
 * the semantics (whether the request is still pending, whether the scope is
 * still valid for that command).
 */

import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

export const commandPermissionResolveSchema = Type.Object({
    workspace: workspaceIdSchema,
    requestId: Type.String({ minLength: 1 }),
    approved: Type.Boolean(),
    scope: Type.Union([Type.Literal("once"), Type.Literal("session"), Type.Literal("global")]),
});
