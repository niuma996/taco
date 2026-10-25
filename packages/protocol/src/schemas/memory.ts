/**
 * memory.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/memory.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * NOTE: the schemas below are `Type.Any()` placeholders — the validation gate
 * accepts anything and never rejects. Tightening to `Type.Object({...})` is
 * tracked as follow-up work; handlers keep their hand-written `XxxParams` types.
 */

import { Type } from "typebox";

export const memoryListSchema = Type.Any();

export const memoryWriteSchema = Type.Any();

export const memoryDeleteTopicSchema = Type.Any();

export const memoryUpsertSchema = Type.Any();

export const memoryDreamRunSchema = Type.Object({ workspace: Type.String({ minLength: 1 }) });

export const memoryDreamApplySchema = Type.Object({
    workspace: Type.String({ minLength: 1 }),
    previewId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
});

export const memoryDreamDiscardSchema = Type.Object({ workspace: Type.String({ minLength: 1 }) });

export const memoryDreamUndoSchema = Type.Object({
    workspace: Type.String({ minLength: 1 }),
    reportId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
});

export const memoryRestoreTopicSchema = Type.Object({
    workspace: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1, maxLength: 128 }),
});
