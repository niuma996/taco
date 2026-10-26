/**
 * workspace.* RPC param schemas — typebox validators consumed by
 * `registerMethod` in `packages/sidecar/src/server/handlers/workspace.ts`.
 *
 * `workspace.list` takes no arguments, and the client sends the call without
 * a `params` field — its schema therefore accepts `undefined` as well as an
 * empty object.
 */

import { Type } from "typebox";

/** A call with no arguments may arrive with or without a `params` field. */
export const noParamsSchema = Type.Union([
    Type.Object({}, { additionalProperties: false }),
    Type.Undefined(),
]);

export const workspaceListSchema = noParamsSchema;

export const workspaceEnsureSchema = Type.Object({
    cwd: Type.String({ minLength: 1 }),
});

export const workspaceDisposeSchema = Type.Object({
    cwd: Type.String({ minLength: 1 }),
});

/**
 * Association key — the storage scope and the id within it.
 *
 * `scope` is a closed enum so a typo becomes `invalid_params` rather than a
 * silently unreachable entry.
 */
const workspaceAssociationKeySchema = Type.Object({
    scope: Type.Union([Type.Literal("workspace"), Type.Literal("channel")]),
    id: Type.String({ minLength: 1 }),
});

export const workspaceAssociationsGetSchema = Type.Object({
    key: workspaceAssociationKeySchema,
});

export const workspaceAssociationsSetSchema = Type.Object({
    key: workspaceAssociationKeySchema,
    roots: Type.Array(Type.String({ minLength: 1 })),
});

export const workspaceAssociationsResolveSchema = Type.Object({
    workspace: Type.String({ minLength: 1 }),
});
