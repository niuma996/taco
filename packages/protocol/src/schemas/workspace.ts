/**
 * workspace.* RPC param schemas — typebox validators consumed by
 * `registerMethod(..., { schema })` in `packages/sidecar/src/server/handlers/workspace.ts`.
 *
 * Schemas here are the intended wire contract for each method's `params`:
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects failures
 * with `invalid_params` carrying JSON-pointer paths.
 *
 * NOTE: the lifecycle schemas below are `Type.Any()` placeholders — the
 * validation gate accepts anything and never rejects. Tightening to
 * `Type.Object({...})` is tracked as follow-up work; handlers keep their
 * hand-written `XxxParams` types. The association schemas ARE strict: they
 * gate a permission grant, so a malformed key must not reach the store.
 */

import { Type } from "typebox";

export const workspaceListSchema = Type.Any();

export const workspaceEnsureSchema = Type.Any();

export const workspaceDisposeSchema = Type.Any();

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
