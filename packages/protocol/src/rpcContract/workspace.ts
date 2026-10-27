/**
 * RPC contract rows — workspace.* — workspace lifecycle and associated directories.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
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
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

/** `workspace.list` result — the known workspace keys. */
export type WorkspaceListResult = WorkspaceId[];

/** `workspace.ensure` result — echoes the ensured workspace key. */
export interface WorkspaceEnsureResult {
    cwd: WorkspaceId;
}

/** `workspace.dispose` result — nothing; the workspace is gone. */
export type WorkspaceDisposeResult = null;

const workspaceRows = {
    workspaceList: row<undefined, WorkspaceListResult>()(
        "workspace.list",
        "process",
        workspaceListSchema,
    ),
    workspaceEnsure: row<{ cwd: WorkspaceId }, WorkspaceEnsureResult>()(
        "workspace.ensure",
        "workspace",
        workspaceEnsureSchema,
    ),
    workspaceDispose: row<{ cwd: WorkspaceId }, WorkspaceDisposeResult>()(
        "workspace.dispose",
        "workspace",
        workspaceDisposeSchema,
    ),
    workspaceAssociationsGet: row<WorkspaceAssociationsGetParams, WorkspaceAssociationsGetResult>()(
        "workspace.associations.get",
        "process",
        workspaceAssociationsGetSchema,
    ),
    workspaceAssociationsSet: row<WorkspaceAssociationsSetParams, WorkspaceAssociationsSetResult>()(
        "workspace.associations.set",
        "process",
        workspaceAssociationsSetSchema,
    ),
    workspaceAssociationsResolve: row<
        WorkspaceAssociationsResolveParams,
        WorkspaceAssociationsResolveResult
    >()("workspace.associations.resolve", "workspace", workspaceAssociationsResolveSchema),
};

export const workspaceMethods = domainMethods(workspaceRows);
export const workspaceContract = domainContract(workspaceRows);
export const workspaceSchemas = domainSchemas(workspaceRows);
