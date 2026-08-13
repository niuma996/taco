/**
 * sessionRead.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/sessionRead.ts`.
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

export const sessionHistorySchema = Type.Any();

export const sessionEventsGetSchema = Type.Any();

export const sessionSnapshotGetSchema = Type.Any();

export const sessionTasksGetSchema = Type.Any();

export const sessionTaskHistoryGetSchema = Type.Any();

export const sessionPlanStateGetSchema = Type.Any();
