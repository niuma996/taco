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

const catalogScope = Type.Union([
    Type.Literal("global"),
    Type.Literal("workspace"),
    Type.Literal("builtin"),
]);

const editableAgentScope = Type.Union([Type.Literal("global"), Type.Literal("workspace")]);

/** Shared with the desktop editor and sidecar's semantic validator. */
export const AGENT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

export const agentsListSchema = Type.Object({
    workspace,
    scope: Type.Optional(catalogScope),
});

export const agentsContentSchema = Type.Object({
    workspace,
    agentType: Type.String({ minLength: 1 }),
    // Select a specific layer when a workspace definition shadows a global one.
    scope: Type.Optional(catalogScope),
});

const agentType = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: AGENT_TYPE_PATTERN.source,
});

const agentScope = editableAgentScope;

export const agentsWriteSchema = Type.Object({
    workspace,
    // Omitted means "global" on create and unchanged on edit. IM conversations
    // reject "workspace" because they have no project directory.
    scope: Type.Optional(agentScope),
    agentType,
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    whenToUse: Type.Optional(Type.String({ maxLength: 2048 })),
    runtime: Type.Optional(
        Type.Union([Type.Literal("standard"), Type.Literal("claude-code"), Type.Literal("codex")]),
    ),
    maxTurns: Type.Integer({ minimum: 1, maximum: 500 }),
    // Wall-clock budget for a background spawn of this agent, in minutes.
    // Omitted = derived from the turn budget (see backgroundTimeoutMs).
    timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
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
    // codex only: engine-specific settings. Sandbox/approval names follow the
    // Codex SDK, not Claude Code's permissionMode — the semantics differ.
    // Closed shape: unknown keys are rejected on the wire instead of ignored.
    codex: Type.Optional(
        Type.Object(
            {
                cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
                model: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
                sandbox: Type.Optional(
                    Type.Union([
                        Type.Literal("read-only"),
                        Type.Literal("workspace-write"),
                        Type.Literal("danger-full-access"),
                    ]),
                ),
                approvalPolicy: Type.Optional(
                    Type.Union([
                        Type.Literal("untrusted"),
                        Type.Literal("on-failure"),
                        Type.Literal("on-request"),
                        Type.Literal("never"),
                    ]),
                ),
            },
            { additionalProperties: false },
        ),
    ),
    systemPrompt: Type.String({ maxLength: 65536 }),
    // Present on rename: after the new file is written, the old definition is
    // deleted. Changing scope moves the definition and removes the old file too.
    previousAgentType: Type.Optional(agentType),
    // Identifies a shadowed source definition when editing it in place.
    previousScope: Type.Optional(editableAgentScope),
});

export const agentsDeleteSchema = Type.Object({
    workspace,
    agentType,
    scope: Type.Optional(editableAgentScope),
});

/**
 * `agents.runtimeStatus` params — process-scoped. Only "codex" is queryable;
 * other runtimes have no managed installation. Closed shape so a caller
 * cannot smuggle in package/version selectors.
 */
export const agentsRuntimeStatusSchema = Type.Object(
    { runtime: Type.Literal("codex") },
    { additionalProperties: false },
);

/**
 * `agents.installRuntime` params — process-scoped. The sidecar installs
 * exactly the pinned managed SDK; the schema names no package or version and
 * rejects any caller-supplied ones via the closed shape.
 */
export const agentsInstallRuntimeSchema = Type.Object(
    { runtime: Type.Literal("codex") },
    { additionalProperties: false },
);

export const skillsListSchema = Type.Object({ workspace, scope: Type.Optional(catalogScope) });

export const skillContentSchema = Type.Object({
    workspace,
    filePath: Type.String({ minLength: 1 }),
    scope: Type.Optional(catalogScope),
});
