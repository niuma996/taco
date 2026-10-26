/**
 * settings.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/settings.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * The global patch remains open because its field set evolves with config,
 * while the surrounding RPC envelope is validated here.
 */

import { Type } from "typebox";

export const settingsGetSchema = Type.Object({});

export const settingsWriteSchema = Type.Object({
    global: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

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
