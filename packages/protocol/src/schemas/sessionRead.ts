/**
 * sessionRead.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/sessionRead.ts`.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them.
 */
import { Type } from "typebox";
import { sessionIdSchema, workspaceIdSchema } from "./fields.js";

export const sessionHistorySchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionEventsGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
    afterSeq: Type.Integer({ minimum: 0 }),
});

export const sessionSnapshotGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionTasksGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});

export const sessionTaskHistoryGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
    listId: Type.String({ minLength: 1 }),
});

export const sessionPlanStateGetSchema = Type.Object({
    workspace: workspaceIdSchema,
    sessionId: sessionIdSchema,
});
