/**
 * settings.* / config.* / mcp.* / providers.* / extensions.* /
 * commandPermission.* RPC param schemas — the global configuration surface.
 *
 * These schemas are the single definition of the request shape: the exported
 * `*Params` types are derived from them. The handlers keep the semantic
 * checks (store validation, approval state) a shape cannot express.
 */
import { Type } from "typebox";
import type { ConfigPatchParams, SettingsWriteParams } from "../configPatch.js";
import { sessionIdSchema, toolCallIdSchema, workspaceIdSchema } from "./fields.js";
import { noParamsSchema } from "./workspace.js";

const workspace = workspaceIdSchema;

/** The provider protocols a custom endpoint can speak. */
const providerApi = Type.Union([
    Type.Literal("chatcomplete"),
    Type.Literal("response"),
    Type.Literal("anthropic"),
]);

export const settingsGetSchema = noParamsSchema;

/** The open patch body: the config's field set evolves, so it stays loose. */
const globalPatchBody = Type.Object({}, { additionalProperties: true });

export const settingsWriteSchema = Type.Unsafe<SettingsWriteParams>(
    Type.Object({ global: Type.Optional(globalPatchBody) }, { additionalProperties: false }),
);

/**
 * `config.patch` params — the model's path to the global config.
 *
 * The patch body stays loose (the config shape has many optional fields, and
 * the handler validates what it accepts), but the envelope is strict: an
 * approval prompt needs the session and tool call to route to.
 */
export const configPatchSchema = Type.Unsafe<ConfigPatchParams>(
    Type.Object({
        workspace: workspaceIdSchema,
        sessionId: sessionIdSchema,
        toolCallId: toolCallIdSchema,
        patch: globalPatchBody,
    }),
);

/**
 * The two provider probes take a discriminated shape: either the id of a
 * saved provider or the fields of one the user is still typing. The schema
 * mirrors that split so a half-filled form fails before the request leaves.
 */
export const providersListSchema = Type.Object({ workspace });

export const providersRevealKeySchema = Type.Object({
    workspace,
    providerId: Type.String({ minLength: 1 }),
});

export const providerListModelsSchema = Type.Union([
    Type.Object({ providerId: Type.String({ minLength: 1 }) }),
    Type.Object({
        baseUrl: Type.String({ minLength: 1 }),
        api: providerApi,
        apiKey: Type.String(),
    }),
]);

export const providerTestConnectionSchema = Type.Union([
    Type.Object({
        providerId: Type.String({ minLength: 1 }),
        modelId: Type.String({ minLength: 1 }),
        apiKey: Type.Optional(Type.String()),
    }),
    Type.Object({
        baseUrl: Type.String({ minLength: 1 }),
        api: providerApi,
        apiKey: Type.String(),
        modelId: Type.String({ minLength: 1 }),
    }),
]);

export const commandPermissionResolveSchema = Type.Object({
    workspace: workspaceIdSchema,
    requestId: Type.String({ minLength: 1 }),
    approved: Type.Boolean(),
    scope: Type.Union([Type.Literal("once"), Type.Literal("session"), Type.Literal("global")]),
});

/** `extensions.status` takes no arguments; the client sends no `params`. */
export const extensionsStatusSchema = noParamsSchema;

/**
 * The MCP server id becomes a tool-name prefix, so it is constrained to the
 * same charset the sidecar's tool-name rewriting accepts.
 */
const serverId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });

const transport = Type.Union([Type.Literal("stdio"), Type.Literal("http")]);

/** The MCP server fields a create or an update patch can carry. */
const serverFields = {
    id: Type.Optional(serverId),
    transport: Type.Optional(transport),
    enabled: Type.Optional(Type.Boolean()),
    command: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    cwd: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    timeoutMs: Type.Optional(Type.Integer()),
    alwaysLoaded: Type.Optional(Type.Array(Type.String())),
};

export const mcpListServersSchema = Type.Object({
    ids: Type.Optional(Type.Array(serverId)),
    forceProbe: Type.Optional(Type.Boolean()),
});

export const mcpGetConfigSchema = Type.Object({ id: serverId });

export const mcpCreateConfigSchema = Type.Object({
    config: Type.Object({
        ...serverFields,
        id: serverId,
        transport,
    }),
});

export const mcpUpdateConfigSchema = Type.Object({
    id: serverId,
    patch: Type.Object(serverFields),
});

export const mcpDeleteConfigSchema = Type.Object({ id: serverId });
