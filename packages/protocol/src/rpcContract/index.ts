/**
 * RPC contract table — the single source of truth for every method the
 * sidecar registers.
 *
 * Each row names one wire method and pins four things together:
 *
 *   - `method`  the wire name (`"session.prompt"`), the value the client sends.
 *   - `params`  the TypeScript type of the `params` object on the wire.
 *   - `result`  the TypeScript type of the value the handler returns.
 *   - `scope`   how the client routes the call: `workspace` (needs a routing
 *               key) or `process` (no workspace dimension).
 *
 * The handler's `params` type and its return type are checked against this
 * table at compile time, so a drifted interface fails the build instead of
 * surfacing as a runtime error. The client side reads the same table, so a
 * method name or result shape cannot differ between the two halves.
 *
 * The table is split by domain (`session.ts`, `workspace.ts`, `settings.ts`,
 * `channels.ts`, `memory.ts`, `jobs.ts`, `misc.ts`). Each domain file owns the
 * wire names, the params/result types, and the params schema for its
 * methods; this module merges them and holds the cross-table assertions.
 *
 * `scope` is the *client routing* dimension. It is deliberately separate from
 * the server's `ensureWorkspace` flag: `workspace.ensure` and
 * `workspace.dispose` are routed by workspace but need no workspace runtime
 * on the server, so the two axes disagree for three methods.
 *
 * Result types that the client never reads as a structured payload are
 * declared as `void` — the wire still carries a value, but no caller depends
 * on its shape, so pinning one would be a false promise.
 */

import type { RpcRequest } from "../frames.js";
import { channelsContract, channelsMethods, channelsSchemas } from "./channels.js";
import { jobsContract, jobsMethods, jobsSchemas } from "./jobs.js";
import { memoryContract, memoryMethods, memorySchemas } from "./memory.js";
import { miscContract, miscMethods, miscSchemas } from "./misc.js";
import { sessionContract, sessionMethods, sessionSchemas } from "./session.js";
import { settingsContract, settingsMethods, settingsSchemas } from "./settings.js";
import type { ParamsLacksShape, RpcContractRow } from "./types.js";
import { workspaceContract, workspaceMethods, workspaceSchemas } from "./workspace.js";

export type { RpcContractRow, RpcScope } from "./types.js";

/** Wire names for every method the sidecar serves. */
export const RPC = {
    ...sessionMethods,
    ...workspaceMethods,
    ...settingsMethods,
    ...channelsMethods,
    ...memoryMethods,
    ...jobsMethods,
    ...miscMethods,
} as const;

/** Params/result types and routing scope for every method. */
export const rpcContract = {
    ...sessionContract,
    ...workspaceContract,
    ...settingsContract,
    ...channelsContract,
    ...memoryContract,
    ...jobsContract,
    ...miscContract,
};

/** Params schemas for every method. */
export const rpcSchemas = {
    ...sessionSchemas,
    ...workspaceSchemas,
    ...settingsSchemas,
    ...channelsSchemas,
    ...memorySchemas,
    ...jobsSchemas,
    ...miscSchemas,
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
