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

import type { Static } from "typebox";
import { channelsContract, channelsMethods, channelsSchemas } from "./channels.js";
import { jobsContract, jobsMethods, jobsSchemas } from "./jobs.js";
import { memoryContract, memoryMethods, memorySchemas } from "./memory.js";
import { miscContract, miscMethods, miscSchemas } from "./misc.js";
import { sessionContract, sessionMethods, sessionSchemas } from "./session.js";
import { settingsContract, settingsMethods, settingsSchemas } from "./settings.js";
import type { DeepMutable, RpcContractRow, SchemaHasShape } from "./types.js";
import { workspaceContract, workspaceMethods, workspaceSchemas } from "./workspace.js";

export type { DeepMutable, RpcContractRow, RpcScope, SchemaHasShape } from "./types.js";

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

/**
 * The wire params type of one contract key.
 *
 * `RpcContractRow` carries the types as optional phantom fields, so the
 * inferred type is `P | undefined`; `NonNullable` removes that. It must not
 * be applied to the *result* type — a method may legitimately return `null`.
 */
export type RpcParams<K extends RpcContractKey> = NonNullable<
    (typeof rpcContract)[K] extends RpcContractRow<infer P, unknown> ? P : never
>;

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

/**
 * The methods whose schema rejects values their contract declares legal.
 *
 * `Params<K> extends Static<schema>` is the check that matters: every value
 * the contract's params type permits must be a value the schema accepts. A
 * schema that requires a field the contract says is optional fails here —
 * the exact `jobs.create` shape where the schema demanded an `id` that no
 * caller sends.
 *
 * Comparing only the outer keys would not catch that: the contract and the
 * schema both have a `job` property, and the disagreement lives one level
 * down. Assignability walks the whole shape.
 *
 * The check is one-directional by construction: it rejects a schema that is
 * *stricter* than the contract, but a schema loosened beyond the contract —
 * a required field turned optional, a narrowed enum widened — still
 * compiles. Loosening a schema is a runtime behaviour change that this
 * assertion cannot see, so it has to be reviewed on its own. The methods
 * that carry real validation today (`jobs.*`) also validate inside their
 * handlers, which is what catches a loosened schema at runtime.
 */
type SchemaRejects<K extends RpcContractKey> = K extends unknown
    ? SchemaHasShape<Static<(typeof rpcSchemas)[K]>> extends true
        ? DeepMutable<RpcParams<K>> extends Static<(typeof rpcSchemas)[K]>
            ? never
            : K
        : never
    : never;

/**
 * The methods whose schema rejects values their contract declares legal.
 *
 * The conditional distributes over the key union, so each method is checked
 * with a *concrete* key — inside a mapped type the key stays generic,
 * `RpcParams<K>` never resolves, and the check silently passes for every
 * method. Distributing here is what makes the verdict meaningful, and it
 * covers a newly added method without touching this file.
 */
type SchemaRejectsSome = SchemaRejects<RpcContractKey>;

/**
 * Compile-time proof that every method's schema accepts its contract's params.
 *
 * The assignment below is the assertion: `false` is not assignable to `true`,
 * so a drift fails the build. A type alias alone would not — an unreferenced
 * alias that resolves to `never` compiles fine, which is how a schema that
 * dropped a field could reach a release unnoticed.
 */
export const schemasAgreeWithParams: [SchemaRejectsSome] extends [never] ? true : false = true;

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
