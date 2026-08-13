/**
 * Method registry — extensible skeleton for server dispatch. Each method
 * has one handler registered via `registerMethod` in `handlers/*.ts`.
 * `SidecarServer` calls `registerBuiltinMethods()` once at startup.
 *
 * commandId idempotency (`command: true`): fingerprint =
 * `JSON.stringify(params)` (byte-exact); commandId is process-scoped —
 * adapters derive stable id, e.g. `sessionId + sha256(canonicalParams)`;
 * retry is best-effort (`commandRecordLimit` 1024, settled-only FIFO prune,
 * TTL via `commandRecordTtlMs`).
 *
 * Schema validation (`schema: TSchema`): when a method registers a typebox
 * schema, `handleRpcRequest` runs `Value.Errors` before dispatch and rejects
 * bad input with `invalid_params`.
 *
 * Two limits worth knowing before relying on this:
 *   1. `MethodCtx<P>`'s `P` is supplied by each handler's own annotation
 *      (e.g. `MethodCtx<PromptParams>`); it is NOT derived from `options.schema`.
 *      Nothing checks that the two agree — a schema/interface drift compiles
 *      cleanly and only surfaces at runtime.
 *   2. `ctx.params` is the raw `req.params` (no `Value.Cast`), so the handler's
 *      static type is an assertion about untrusted input, not a guarantee.
 * Both are acceptable only while the schemas remain `Type.Any()` placeholders
 * that reject nothing; tightening them requires closing these gaps first.
 */

import type { WorkspaceId } from "@taco-ai/protocol";
import type { TSchema } from "typebox";
import type { ServerRpcSurface } from "../runtime/serverRpcSurface.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";

export interface MethodCtx<P> {
    readonly id: string;
    readonly workspace: WorkspaceRuntime;
    readonly cwd: WorkspaceId;
    readonly server: ServerRpcSurface;
    readonly params: P;
}

export type MethodHandler<P = unknown> = (ctx: MethodCtx<P>) => Promise<unknown>;
type AnyMethodHandler = (ctx: MethodCtx<unknown>) => Promise<unknown>;

interface RegisteredMethod {
    ensureWorkspace: boolean;
    options: RegisterMethodOptions;
    handler: AnyMethodHandler;
}

export interface RegisterMethodOptions {
    /** Workspace route param extracted from params; used by workspace.* lifecycle methods with `cwd`. */
    workspaceParam?: "workspace" | "cwd";
    /** Mutating command; identical commandId values are deduplicated by SidecarServer. */
    command?: boolean;
    /** Starts an exclusive model turn for params.workspace + params.sessionId. */
    turnStart?: boolean;
    /**
     * Optional typebox schema for `params`. When set, `handleRpcRequest`
     * validates incoming params before dispatch; failures return
     * `invalid_params` with `data.issues: { path, message, schema }[]`.
     * Does NOT influence the handler's `params` type — see the file header.
     */
    schema?: TSchema;
}

const registry = new Map<string, RegisteredMethod>();

export function registerMethod<P>(
    name: string,
    ensureWorkspace: boolean,
    handler: MethodHandler<P>,
    options: RegisterMethodOptions = {},
): void {
    registry.set(name, {
        ensureWorkspace,
        options,
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
