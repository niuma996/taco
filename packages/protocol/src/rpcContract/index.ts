/**
 * RPC contract table — the single source of truth for every method the
 * sidecar registers. Each domain file owns its wire names, types and params
 * schema; this module merges them and holds the cross-table assertions.
 *
 * Handlers are checked against this table at compile time and the client
 * reads the same table, so a drifted interface fails the build.
 *
 * `scope` is the client routing dimension, separate from the server's
 * `ensureWorkspace` flag: `workspace.ensure` / `workspace.dispose` are
 * routed by workspace but need no workspace runtime on the server.
 */

import type { RpcRequest } from "../frames.js";
import { attachmentContract, attachmentMethods, attachmentSchemas } from "./attachment.js";
import { channelsContract, channelsMethods, channelsSchemas } from "./channels.js";
import { jobsContract, jobsMethods, jobsSchemas } from "./jobs.js";
import { memoryContract, memoryMethods, memorySchemas } from "./memory.js";
import { sessionContract, sessionMethods, sessionSchemas } from "./session.js";
import { settingsContract, settingsMethods, settingsSchemas } from "./settings.js";
import { toolsContract, toolsMethods, toolsSchemas } from "./tools.js";
import type { ParamsLacksShape, RpcContractRow } from "./types.js";
import { workContract, workMethods, workSchemas } from "./work.js";
import { workspaceContract, workspaceMethods, workspaceSchemas } from "./workspace.js";

export type { RpcContractRow, RpcScope } from "./types.js";

/** Wire names for every method the sidecar serves. */
export const RPC = {
    ...sessionMethods,
    ...attachmentMethods,
    ...workspaceMethods,
    ...settingsMethods,
    ...channelsMethods,
    ...memoryMethods,
    ...jobsMethods,
    ...toolsMethods,
    ...workMethods,
} as const;

/** Params/result types and routing scope for every method. */
export const rpcContract = {
    ...sessionContract,
    ...attachmentContract,
    ...workspaceContract,
    ...settingsContract,
    ...channelsContract,
    ...memoryContract,
    ...jobsContract,
    ...toolsContract,
    ...workContract,
};

/** Params schemas for every method. */
export const rpcSchemas = {
    ...sessionSchemas,
    ...attachmentSchemas,
    ...workspaceSchemas,
    ...settingsSchemas,
    ...channelsSchemas,
    ...memorySchemas,
    ...jobsSchemas,
    ...toolsSchemas,
    ...workSchemas,
};

/** Every camelCase contract key. */
export type RpcContractKey = keyof typeof rpcContract;

/** Every wire method name the sidecar serves. */
export type RpcMethodName = (typeof RPC)[RpcContractKey];

/** The wire params type, preserving undefined for calls with no params. */
export type RpcParams<K extends RpcContractKey> =
    (typeof rpcContract)[K] extends RpcContractRow<infer P, unknown> ? P : never;

/** The wire result type of one contract key. */
export type RpcResult<K extends RpcContractKey> =
    (typeof rpcContract)[K] extends RpcContractRow<unknown, infer R> ? R : never;

/** The client routing scope of one contract key. */
export type RpcScopeOf<K extends RpcContractKey> = (typeof rpcContract)[K]["scope"];

/** Every contract key whose scope is `workspace` — routed with a workspace key. */
export type WorkspaceScopedKey = {
    [K in RpcContractKey]: RpcScopeOf<K> extends "workspace" ? K : never;
}[RpcContractKey];

/** Every contract key whose scope is `process` — routed without a workspace key. */
export type ProcessScopedKey = {
    [K in RpcContractKey]: RpcScopeOf<K> extends "process" ? K : never;
}[RpcContractKey];

/** Every method must belong to exactly one routing scope. */
export const scopeCoversAllKeys: [WorkspaceScopedKey | ProcessScopedKey] extends [RpcContractKey]
    ? [RpcContractKey] extends [WorkspaceScopedKey | ProcessScopedKey]
        ? true
        : false
    : false = true;

/**
 * Compile-time proof that the constant table and the contract table list the
 * same methods. Assigned rather than aliased for the same reason as above.
 */
export const contractKeysMatchRpcKeys: [RpcContractKey, keyof typeof RPC] extends [infer A, infer B]
    ? [A] extends [B]
        ? [B] extends [A]
            ? true
            : false
        : false
    : false = true;

/**
 * The methods whose params type carries no field information.
 *
 * Every params type is derived from its schema, so a schema that widens to
 * `Type.Any()` / `Type.Unknown()` without a `Type.Unsafe` pin would erase
 * the request shape: callers would pass anything and the build would stay
 * quiet. This names the methods that lost their shape, so the check below
 * fails instead.
 */
type UntypedParams<K extends RpcContractKey> = K extends unknown
    ? ParamsLacksShape<RpcParams<K>> extends true
        ? K
        : never
    : never;

/**
 * Compile-time proof that every method still has a typed request shape.
 *
 * Assigned rather than aliased, like the assertions above: the assignment
 * is what makes the check fail the build instead of sitting unused.
 */
export const paramsTypesAreTyped: [UntypedParams<RpcContractKey>] extends [never] ? true : false =
    true;

/** Resolve a wire method to its contract row without duplicating the name table. */
export type RpcKeyForMethod<M extends RpcMethodName> = {
    [K in RpcContractKey]: (typeof RPC)[K] extends M ? K : never;
}[RpcContractKey];
type RpcMethods = {
    [K in RpcContractKey as (typeof RPC)[K]]: {
        params: RpcParams<K>;
        result: RpcResult<K>;
    };
};
export type RpcMethodParams<M extends RpcMethodName> = RpcMethods[M]["params"];
export type RpcMethodResult<M extends RpcMethodName> = RpcMethods[M]["result"];

/** Build an internal request with the same params contract as external clients. */
export function createRpcRequest<M extends RpcMethodName>(
    id: string,
    method: M,
    params: NoInfer<RpcMethodParams<M>>,
    commandId?: string,
): RpcRequest {
    return commandId === undefined ? { id, method, params } : { id, commandId, method, params };
}
