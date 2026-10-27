/**
 * checkpoints.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/checkpoints.ts`.
 */

import { Type } from "typebox";
import { sessionIdSchema, workspaceIdSchema } from "./fields.js";

const workspace = workspaceIdSchema;

export const checkpointsListSchema = Type.Object({
    workspace,
    sessionId: Type.Optional(sessionIdSchema),
});

export const checkpointsRestoreSchema = Type.Object({
    workspace,
    checkpointId: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(sessionIdSchema),
});
