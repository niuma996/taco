/**
 * agents.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/agents.ts`.
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

export const agentsListSchema = Type.Any();

export const agentsContentSchema = Type.Any();

const agentType = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});

export const agentsWriteSchema = Type.Object({
    workspace: Type.String(),
    agentType,
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    whenToUse: Type.Optional(Type.String({ maxLength: 2048 })),
    runtime: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("claude-code")])),
    maxTurns: Type.Integer({ minimum: 1, maximum: 200 }),
    systemPrompt: Type.String({ maxLength: 65536 }),
    previousAgentType: Type.Optional(agentType),
});

export const agentsDeleteSchema = Type.Object({
    workspace: Type.String(),
    agentType,
});
