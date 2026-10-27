/**
 * tools.* / agents.* / skills.* RPC param schemas — the catalog reads.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them.
 */
import { Type } from "typebox";
import { workspaceIdSchema } from "./fields.js";

const workspace = workspaceIdSchema;

export const toolsListSchema = Type.Object({ workspace });

/** Shared with the desktop editor and sidecar's semantic validator. */
export const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

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
    workspace,
    // Omitted means "global" on create and unchanged on edit. IM conversations
    // reject "workspace" because they have no project directory.
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
    // claude-code only: an absolute workspace or associated directory. The
    // handler rejects paths outside that set; omitted means the calling workspace.
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    systemPrompt: Type.String({ maxLength: 65536 }),
    // Present on rename: after the new file is written, the old definition is
    // deleted. Changing scope moves the definition and removes the old file too.
    previousAgentType: Type.Optional(agentType),
});

export const agentsDeleteSchema = Type.Object({
    workspace,
    agentType,
});

export const skillsListSchema = Type.Object({ workspace });

export const skillContentSchema = Type.Object({
    workspace,
    filePath: Type.String({ minLength: 1 }),
});
