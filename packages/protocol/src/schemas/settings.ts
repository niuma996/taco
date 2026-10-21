/**
 * settings.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/settings.ts`.
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

export const settingsGetSchema = Type.Any();

export const settingsWriteSchema = Type.Any();

/**
 * `config.patch` params — the model's path to the global config.
 *
 * The patch body stays loose (the config shape has many optional fields, and
 * the handler validates what it accepts), but the envelope is strict: an
 * approval prompt needs the session and tool call to route to.
 */
export const configPatchSchema = Type.Object({
    workspace: Type.String({ minLength: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    toolCallId: Type.String({ minLength: 1 }),
    patch: Type.Object({}, { additionalProperties: true }),
});
