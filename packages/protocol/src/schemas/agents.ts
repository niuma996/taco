/**
 * agents.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/agents.ts`.
 *
 * The write/delete bodies carry the concrete wire validation; list/content
 * only need the routing envelope.
 */

import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

/** Shared with the desktop editor and sidecar's semantic validator. */
export const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

const workspace = workspaceIdSchema;

export const agentsListSchema = Type.Object({ workspace });

export const agentsContentSchema = Type.Object({
    workspace,
    agentType: Type.String({ minLength: 1 }),
});

const agentType = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: AGENT_TYPE_PATTERN.source,
});

const agentScope = Type.Union([Type.Literal("global"), Type.Literal("workspace")]);

export const agentsWriteSchema = Type.Object({
    workspace: workspaceIdSchema,
    scope: Type.Optional(agentScope),
    agentType,
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    whenToUse: Type.Optional(Type.String({ maxLength: 2048 })),
    runtime: Type.Optional(Type.Union([Type.Literal("standard"), Type.Literal("claude-code")])),
    maxTurns: Type.Integer({ minimum: 1, maximum: 200 }),
    tools: Type.Optional(
        Type.Array(
            Type.String({
                minLength: 1,
                maxLength: 128,
                pattern: AGENT_TOOL_NAME_PATTERN.source,
            }),
            { maxItems: 64 },
        ),
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
    workspace: workspaceIdSchema,
    agentType,
});
