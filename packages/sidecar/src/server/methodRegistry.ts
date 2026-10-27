/**
 * Method registry — server-side dispatch table.
 *
 * Each method is registered once via `registerMethod`, which checks the
 * handler against the shared contract table in `@taco-ai/protocol`: the
 * `params` type the handler sees and the type it returns must be the ones
 * the contract declares for that method. A drifted handler or a drifted
 * contract therefore fails the build instead of surfacing as a runtime
 * error.
 *
 * `commandId` idempotency (`command: true`): fingerprint =
 * `JSON.stringify(params)` (byte-exact); commandId is process-scoped —
 * adapters derive stable id, e.g. `sessionId + sha256(canonicalParams)`;
 * retry is best-effort (`commandRecordLimit` defaults to 1024 and clamps to 1,
 * settled-only FIFO prune,
 * TTL via `commandRecordTtlMs`).
 *
 * Schema validation: the params schema comes from the contract table, so a
 * method cannot be registered with a schema that belongs to another method.
 * `handleRpcRequest` runs `Value.Errors` before dispatch and rejects bad
 * input with `invalid_params`.
 *
 * That guarantee is about *pairing*, not depth: every registered method now
 * carries a schema, and the compile-time assertion in the contract table
 * keeps each schema at least as permissive as the params type it serves.
 * The remaining gap is the other direction — a schema may be looser than the
 * contract (a required field turned optional, an enum widened) and the
 * assertion cannot see it, so handlers keep their own semantic checks.
 *
 * Three limits worth knowing before relying on this:
 *   1. `ctx.params` is the raw `req.params` (no `Value.Cast`), so a
 *      handler's params type is an assertion about untrusted input, not a
 *      guarantee. Handlers with concrete schemas must still keep defensive
 *      runtime checks for values whose semantics are stricter than the wire
 *      shape.
 *   2. `ensureWorkspace` is the server's routing decision and is separate
 *      from the contract's `scope`, which is the client's routing dimension.
 *      They disagree for `workspace.ensure`, `workspace.dispose` and
 *      `workspace.associations.resolve`, which are routed by workspace but
 *      need no workspace runtime on the server.
 *   3. The contract table's schema assertion is one-directional: it rejects
 *      a schema that is *stricter* than the contract declares, but a schema
 *      loosened beyond the contract still compiles. See `rpcContract.ts`.
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
import type { ServerRegistry } from "./serverRegistry.ts";

export interface MethodCtx<P> {
    readonly id: string;
    readonly workspace: WorkspaceRuntime;
    readonly cwd: WorkspaceId;
    readonly server: ServerRpcSurface;
    /**
     * Process-level fan-out registry of every SidecarServer in the
     * current process (daemon mode). Handlers that touch process-wide
     * state (settings.write calling one of its five setters) iterate
     * `serverRegistry?.all() ?? [server]` instead of calling on the
     * per-RPC server alone. Undefined in stdio / test sidecars, which
     * have a single server.
     */
    readonly serverRegistry?: ServerRegistry;
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
