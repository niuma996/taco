/**
 * sessionRead.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/sessionRead.ts`.
 */

import { Type } from "typebox";

const workspace = Type.String({ minLength: 1 });
const sessionId = Type.String({ minLength: 1 });

export const sessionHistorySchema = Type.Object({ workspace, sessionId });

export const sessionEventsGetSchema = Type.Object({
    workspace,
    sessionId,
    afterSeq: Type.Integer({ minimum: 0 }),
});

export const sessionSnapshotGetSchema = Type.Object({ workspace, sessionId });

export const sessionTasksGetSchema = Type.Object({ workspace, sessionId });

export const sessionTaskHistoryGetSchema = Type.Object({
    workspace,
    sessionId,
    listId: Type.String({ minLength: 1 }),
});

export const sessionPlanStateGetSchema = Type.Object({ workspace, sessionId });
