/**
 * work.* RPC param schemas, consumed by the contract table in
 * `rpcContract/work.ts`. The request types in `work.ts` are read off these.
 */

import { Type } from "typebox";

/** Largest page `work.list` accepts. */
export const WORK_LIST_MAX_LIMIT = 200;

/** Same shape the sidecar derives, so a path-like id is rejected at the door. */
const workIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
});

export const workListSchema = Type.Object({
    /** Finished Works per page. */
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: WORK_LIST_MAX_LIMIT })),
    /** Cursor from a previous result's `nextCursor`. */
    before: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    /** Only the fires of this scheduled job; a job's run history reads its Works this way. */
    jobId: Type.Optional(
        Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
    ),
});

export const workGetSchema = Type.Object({
    workId: workIdSchema,
});

export const workRetryDeliverySchema = Type.Object({
    workId: workIdSchema,
});

export const workCancelSchema = Type.Object({
    workId: workIdSchema,
    attemptId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const workDeleteSchema = Type.Object({
    workId: workIdSchema,
});
