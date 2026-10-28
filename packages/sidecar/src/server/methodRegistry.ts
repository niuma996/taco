/**
 * Registers handlers against the protocol's params/result types and schema.
 * Params are derived from that schema; explicit Type.Unsafe pins remain trust
 * boundaries. Validation checks raw input without casting or stripping fields.
 * Handlers retain semantic checks (permissions, state, conflicts, open bodies).
 * Client scope and server ensureWorkspace are separate: workspace.ensure,
 * workspace.dispose and workspace.associations.resolve need no runtime up front.
 * Mutations marked command use process-scoped commandId deduplication with
 * byte-exact JSON.stringify(params) fingerprints and bounded settled records.
 */

import type { WorkspaceId } from "@taco-ai/protocol";
import {
    RPC,
    type RpcContractKey,
    type RpcParams,
    type RpcResult,
    rpcSchemas,
} from "@taco-ai/protocol";
import type { ServerRpcSurface } from "../runtime/serverRpcSurface.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";

export interface MethodCtx<P> {
    readonly id: string;
    readonly workspace: WorkspaceRuntime;
    readonly cwd: WorkspaceId;
    readonly server: ServerRpcSurface;
    readonly params: P;
}

/**
 * A method handler.
 *
 * `R` is the result type the contract declares for the method. It is not
 * `unknown`: the registry stores handlers generically, but a handler that
 * returns the wrong shape is rejected where it is registered.
 */
export type MethodHandler<P, R> = (ctx: MethodCtx<P>) => Promise<R>;

interface RegisteredMethod {
    ensureWorkspace: boolean;
    options: RegisterMethodOptions;
    /** Params validator, taken from the contract table so it cannot be paired with the wrong method. */
    schema: unknown;
    handler: AnyMethodHandler;
}

type AnyMethodHandler = (ctx: MethodCtx<unknown>) => Promise<unknown>;

export interface RegisterMethodOptions {
    /** Workspace route param extracted from params; used by workspace.* lifecycle methods with `cwd`. */
    workspaceParam?: "workspace" | "cwd";
    /** Mutating command; identical commandId values are deduplicated by SidecarServer. */
    command?: boolean;
    /** Starts an exclusive model turn for params.workspace + params.sessionId. */
    turnStart?: boolean;
}

const registry = new Map<string, RegisteredMethod>();

/**
 * Registers one method.
 *
 * `key` names a row in the protocol contract table. The handler's params
 * and result types are checked against that row: a handler that reads a
 * field the contract does not declare, or returns a different shape, fails
 * to compile here.
 *
 * The registry itself is keyed by the wire method name, because that is what
 * the dispatcher looks up.
 */
export function registerMethod<K extends RpcContractKey>(
    key: K,
    ensureWorkspace: boolean,
    handler: MethodHandler<RpcParams<K>, RpcResult<K>>,
    options: RegisterMethodOptions = {},
): void {
    registry.set(RPC[key], {
        ensureWorkspace,
        options,
        schema: rpcSchemas[key],
        handler: handler as AnyMethodHandler,
    });
}

/**
 * Registers a method that is not part of the wire contract.
 *
 * Tests use this to stand up a probe method without adding it to the
 * published contract. Production methods belong in the contract table and
 * should use {@link registerMethod} so their types stay checked.
 */
export function registerAdhocMethod(
    method: string,
    ensureWorkspace: boolean,
    handler: MethodHandler<unknown, unknown>,
    options: RegisterMethodOptions = {},
): void {
    registry.set(method, {
        ensureWorkspace,
        options,
        schema: undefined,
        handler: handler as AnyMethodHandler,
    });
}

export function getRegisteredMethod(name: string): RegisteredMethod | undefined {
    return registry.get(name);
}

/** All registered method names — sorted. Used to populate hello capabilities. */
export function listRegisteredMethods(): string[] {
    return [...registry.keys()].sort();
}

/** Handlers throw RpcHandlerError to carry code/message; dispatch turns it into RpcResponse.error */
export class RpcHandlerError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly data?: unknown,
    ) {
        super(message);
        this.name = "RpcHandlerError";
    }
}
