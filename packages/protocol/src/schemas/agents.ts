/**
 * agents.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/agents.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * List/content remain permissive because their params are normalized by the
 * typed client. Write/delete use concrete wire validation before dispatch.
 */

import { Type } from "typebox";

export const agentsListSchema = Type.Any();

export const agentsContentSchema = Type.Any();

const agentType = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});

const agentScope = Type.Union([Type.Literal("global"), Type.Literal("workspace")]);

export const agentsWriteSchema = Type.Object({
    workspace: Type.String(),
    scope: Type.Optional(agentScope),
    agentType,
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    whenToUse: Type.Optional(Type.String({ maxLength: 2048 })),
    runtime: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("claude-code")])),
    maxTurns: Type.Integer({ minimum: 1, maximum: 200 }),
    tools: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 }),
    ),
    permissionMode: Type.Optional(
        Type.Union([
            Type.Literal("auto"),
            Type.Literal("default"),
            Type.Literal("acceptEdits"),
            Type.Literal("plan"),
            Type.Literal("dontAsk"),
            Type.Literal("bypassPermissions"),
            Type.Literal("inherit"),
        ]),
    ),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    systemPrompt: Type.String({ maxLength: 65536 }),
    previousAgentType: Type.Optional(agentType),
});

export const agentsDeleteSchema = Type.Object({
    workspace: Type.String(),
    agentType,
});
