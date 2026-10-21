/**
 * workspace.* handler — workspace lifecycle (list / ensure / dispose) plus
 * the directory-association admin surface.
 *
 * The association methods are process-level (`ensureWorkspace: false`): a
 * key names a workspace OR a channel, and a channel is not a routing key.
 * `resolve` takes a workspace and is routed by it.
 */

import type {
    WorkspaceAssociationKey,
    WorkspaceAssociationsGetParams,
    WorkspaceAssociationsResolveParams,
    WorkspaceAssociationsSetParams,
} from "@taco-ai/protocol";
import {
    asWorkspaceId,
    workspaceAssociationsGetSchema,
    workspaceAssociationsResolveSchema,
    workspaceAssociationsSetSchema,
    workspaceDisposeSchema,
    workspaceEnsureSchema,
    workspaceListSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { AssociationValidationError } from "../../workspace/associationStore.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

/**
 * Validate the key shape.
 *
 * The typebox schema already checked the wire shape, but the handler's
 * params type is an assertion about untrusted input — `methodRegistry.ts`
 * says so explicitly — so the check repeats here.
 */
function requireKey(
    params: { key?: WorkspaceAssociationKey } | undefined,
): WorkspaceAssociationKey {
    const key = params?.key;
    if (!key || typeof key !== "object") {
        throw new RpcHandlerError("invalid_params", "key is required");
    }
    if (key.scope !== "workspace" && key.scope !== "channel") {
        throw new RpcHandlerError("invalid_params", `unknown key scope: ${String(key.scope)}`);
    }
    if (typeof key.id !== "string" || key.id.length === 0) {
        throw new RpcHandlerError("invalid_params", "key.id is required");
    }
    return key;
}

/**
 * Turn a validation failure into a coded `invalid_params` response.
 *
 * Without this, `normalizeError` would flatten it to `internal` and the
 * desktop would lose the reason the grant was refused — which is the one
 * thing the user needs to see (it names the offending path and the rule).
 */
function mapValidationError(e: unknown): never {
    if (e instanceof AssociationValidationError) {
        throw new RpcHandlerError("invalid_params", e.message);
    }
    throw e;
}

export function registerWorkspaceHandlers(): void {
    registerMethod(
        RPC.workspaceList,
        false,
        async ({ server }) => {
            return [...server.workspaceIds()];
        },
        { schema: workspaceListSchema },
    );

    registerMethod(
        RPC.workspaceEnsure,
        false,
        async ({ cwd, server }) => {
            await server.ensureWorkspace(cwd);
            return { cwd };
        },
        { workspaceParam: "cwd", command: true, schema: workspaceEnsureSchema },
    );

    registerMethod(
        RPC.workspaceDispose,
        false,
        async ({ cwd, server }) => {
            await server.disposeWorkspace(cwd);
            return null;
        },
        { workspaceParam: "cwd", command: true, schema: workspaceDisposeSchema },
    );

    registerMethod(
        RPC.workspaceAssociationsGet,
        false,
        async ({ server, params }: MethodCtx<WorkspaceAssociationsGetParams>) => {
            const key = requireKey(params);
            return { roots: server.associations.get(key) };
        },
        { schema: workspaceAssociationsGetSchema },
    );

    registerMethod(
        RPC.workspaceAssociationsSet,
        false,
        async ({ server, params }: MethodCtx<WorkspaceAssociationsSetParams>) => {
            const key = requireKey(params);
            const roots = params?.roots;
            if (!Array.isArray(roots)) {
                throw new RpcHandlerError("invalid_params", "roots must be an array");
            }
            try {
                const stored = await server.associations.set(key, roots);
                return { roots: stored };
            } catch (e) {
                mapValidationError(e);
            }
        },
        { schema: workspaceAssociationsSetSchema },
    );

    registerMethod(
        RPC.workspaceAssociationsResolve,
        false,
        async ({ server, params }: MethodCtx<WorkspaceAssociationsResolveParams>) => {
            const workspace = params?.workspace;
            if (typeof workspace !== "string" || workspace.length === 0) {
                throw new RpcHandlerError("invalid_params", "workspace is required");
            }
            const resolved = server.associations.resolve(asWorkspaceId(workspace));
            return resolved.source
                ? { roots: resolved.roots, source: resolved.source }
                : { roots: resolved.roots };
        },
        { workspaceParam: "workspace", schema: workspaceAssociationsResolveSchema },
    );
}
