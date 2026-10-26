/**
 * checkpoints.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/checkpoints.ts`.
 */

import { Type } from "typebox";

const workspace = Type.String({ minLength: 1 });

export const checkpointsListSchema = Type.Object({
    workspace,
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
});

export const checkpointsRestoreSchema = Type.Object({
    workspace,
    checkpointId: Type.String({ minLength: 1 }),
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
});
