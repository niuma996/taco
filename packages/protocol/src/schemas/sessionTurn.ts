/**
 * sessionTurn.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/sessionTurn.ts`.
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

export const sessionPromptSchema = Type.Any();

export const sessionSteerSchema = Type.Any();

export const sessionAbortSchema = Type.Any();

export const sessionSetModelSchema = Type.Any();

export const sessionSetThinkingLevelSchema = Type.Any();

export const sessionCompactSchema = Type.Any();

export const sessionContextInfoSchema = Type.Any();

export const sessionSubmitAnswersSchema = Type.Any();
