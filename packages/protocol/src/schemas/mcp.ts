/**
 * mcp.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/mcp.ts`.
 *
 * The MCP server id becomes a tool-name prefix, so it is constrained to the
 * same charset the sidecar's tool-name rewriting accepts.
 */

import { Type } from "typebox";

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
