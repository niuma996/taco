/**
 * Invokes a registered RPC handler with a minimal MethodCtx. `workspace` /
 * `cwd` are never exercised by handler-level tests, so they stay undefined;
 * `serverRegistry` is set only when the test exercises process fan-out.
 */
import { getRegisteredMethod, type MethodCtx } from "../../src/server/methodRegistry.ts";

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
