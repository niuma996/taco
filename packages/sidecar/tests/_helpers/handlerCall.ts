/**
 * Invokes a registered RPC handler with a minimal MethodCtx. `workspace` /
 * `cwd` are never exercised by handler-level tests, so they stay undefined;
 * `serverRegistry` is set only when the test exercises process fan-out.
 *
 * The registered schema validates the params first, exactly as the server
 * does before dispatch. Without that step a handler test could hand a
 * handler a payload the wire would have rejected, and the handler's own
 * shape checks would look load-bearing when production never reaches them.
 */
import { Value } from "typebox/value";
import {
    getRegisteredMethod,
    type MethodCtx,
    RpcHandlerError,
} from "../../src/server/methodRegistry.ts";

export async function callMethod<T = unknown>(
    name: string,
    args: {
        server?: unknown;
        params?: unknown;
        serverRegistry?: unknown;
        workspace?: unknown;
    } = {},
): Promise<T> {
    const reg = getRegisteredMethod(name);
    if (!reg) throw new Error(`unregistered: ${name}`);
    if (reg.schema) {
        const errors = [...Value.Errors(reg.schema, args.params)];
        if (errors.length > 0) {
            const details = errors.map((e) => `${e.instancePath || "/"} (${e.message})`).join("; ");
            throw new RpcHandlerError("invalid_params", `parameter validation failed: ${details}`);
        }
    }
    const ctx: MethodCtx<unknown> = {
        id: "test",
        workspace: args.workspace as never,
        cwd: undefined as never,
        server: args.server as never,
        serverRegistry: args.serverRegistry as never,
        params: args.params,
    };
    return (await reg.handler(ctx)) as T;
}
