/**
 * RPC contract rows — workspace.* — workspace lifecycle and associated directories.
 *
 * Three tables move together: the wire name, the params/result types, and the
 * params schema. `rpcContract/index.ts` merges them into the single
 * `RPC` / `rpcContract` / `rpcSchemas` exports that the client and the
 * sidecar both read.
 *
 * Adding a method to this domain means adding one entry to each of the three
 * tables below — the compile-time assertions in the index catch a row that
 * was added to one and forgotten in another.
 */

import type { WorkspaceId } from "../frames.js";
import {
    workspaceAssociationsGetSchema,
    workspaceAssociationsResolveSchema,
    workspaceAssociationsSetSchema,
    workspaceDisposeSchema,
    workspaceEnsureSchema,
    workspaceListSchema,
} from "../schemas/index.js";
import type {
    WorkspaceAssociationsGetParams,
    WorkspaceAssociationsGetResult,
    WorkspaceAssociationsResolveParams,
    WorkspaceAssociationsResolveResult,
    WorkspaceAssociationsSetParams,
    WorkspaceAssociationsSetResult,
} from "../workspace.js";
import type { RpcContractRow } from "./types.js";

/** `workspace.list` result — the known workspace keys. */
export type WorkspaceListResult = WorkspaceId[];

/** `workspace.ensure` result — echoes the ensured workspace key. */
export interface WorkspaceEnsureResult {
    cwd: WorkspaceId;
}

/** `workspace.dispose` result — nothing; the workspace is gone. */
export type WorkspaceDisposeResult = null;

/** Wire names for this domain. */
export const workspaceMethods = {
    workspaceList: "workspace.list",
    workspaceEnsure: "workspace.ensure",
    workspaceDispose: "workspace.dispose",
    /** Read the associated-directory set stored at one key (workspace or channel scope). */
    workspaceAssociationsGet: "workspace.associations.get",
    /** Replace the associated-directory set stored at one key. */
    workspaceAssociationsSet: "workspace.associations.set",
    /** The effective associated-directory set for a workspace, after the scope fallback. */
    workspaceAssociationsResolve: "workspace.associations.resolve",
    // session.*
} as const;

/** Params/result types and routing scope for this domain. */
export const workspaceContract = {
    workspaceList: { scope: "process" } as RpcContractRow<void, WorkspaceListResult>,
    workspaceEnsure: { scope: "workspace" } as RpcContractRow<
        { cwd: WorkspaceId },
        WorkspaceEnsureResult
    >,
    workspaceDispose: { scope: "workspace" } as RpcContractRow<
        { cwd: WorkspaceId },
        WorkspaceDisposeResult
    >,
    workspaceAssociationsGet: { scope: "process" } as RpcContractRow<
        WorkspaceAssociationsGetParams,
        WorkspaceAssociationsGetResult
    >,
    workspaceAssociationsSet: { scope: "process" } as RpcContractRow<
        WorkspaceAssociationsSetParams,
        WorkspaceAssociationsSetResult
    >,
    workspaceAssociationsResolve: { scope: "workspace" } as RpcContractRow<
        WorkspaceAssociationsResolveParams,
        WorkspaceAssociationsResolveResult
    >,
};

/** Params schemas for this domain. */
export const workspaceSchemas = {
    workspaceList: workspaceListSchema,
    workspaceEnsure: workspaceEnsureSchema,
    workspaceDispose: workspaceDisposeSchema,
    workspaceAssociationsGet: workspaceAssociationsGetSchema,
    workspaceAssociationsSet: workspaceAssociationsSetSchema,
    workspaceAssociationsResolve: workspaceAssociationsResolveSchema,
};
