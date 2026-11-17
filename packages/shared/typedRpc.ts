/**
 * @taco-ai/shared — typed RPC surface factory.
 *
 * Generates one client method per protocol contract row. Each transport
 * (Node child_process, Tauri sidecar) implements `RpcDispatch` and passes it
 * here; the method name, routing scope, and params/result types all come from
 * `@taco-ai/protocol`, so adding an RPC needs no change in this file.
 */

import {
    type PromptParams,
    RPC,
    type RpcContractKey,
    type RpcParams,
    type RpcResult,
    rpcContract,
    type SteerParams,
    type WorkspaceId,
} from "@taco-ai/protocol";
import { createContractDispatch, type RpcDispatch } from "./contractDispatch.js";

// jobs.* belongs to the dedicated scheduler facade, while config.patch is
// invoked internally by the config tool rather than exposed to app clients.
type TypedRpcKey = Exclude<RpcContractKey, `jobs${string}` | "configPatch">;

function isTypedRpcKey(key: RpcContractKey): key is TypedRpcKey {
    return !key.startsWith("jobs") && key !== "configPatch";
}

type RpcMethod<K extends RpcContractKey> =
    undefined extends RpcParams<K>
        ? (params?: RpcParams<K>) => Promise<RpcResult<K>>
        : (params: RpcParams<K>) => Promise<RpcResult<K>>;

/**
 * The client RPC surface: one method per contract row, taking the wire params
 * object as declared by the protocol schema. Only methods whose schema is
 * `noParams` may be called without an argument.
 */
export type TypedRpc = { readonly [K in TypedRpcKey]: RpcMethod<K> };

/**
 * Drop empty optional turn fields so the wire carries only what the caller set;
 * an empty `images` array would otherwise reach the server's image branch.
 */
function compactTurnParams<P extends SteerParams & { model?: PromptParams["model"] }>(
    params: P,
): P {
    const { images, attachments, uiLocale, model, ...rest } = params;
    return {
        ...rest,
        ...(images && images.length > 0 ? { images } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(uiLocale ? { uiLocale } : {}),
        ...(model ? { model } : {}),
    } as P;
}

export function createTypedRpc(dispatch: RpcDispatch): TypedRpc {
    const methods: Record<string, (params?: unknown) => Promise<unknown>> = {};
    for (const key of Object.keys(rpcContract) as RpcContractKey[]) {
        if (!isTypedRpcKey(key)) continue;
        const method = RPC[key];
        const row = rpcContract[key];
        if (row.scope === "process") {
            methods[key] = (params) => dispatch.callProcess(method, params);
        } else {
            const routeField = row.routeParam;
            methods[key] = (params) =>
                dispatch.call(method, (params as Record<string, WorkspaceId>)[routeField], params);
        }
    }
    const generated = methods as unknown as TypedRpc;
    const contract = createContractDispatch(dispatch);
    return {
        ...generated,
        sessionPrompt: (params) =>
            contract.call(RPC.sessionPrompt, params.workspace, compactTurnParams(params)),
        sessionSteer: (params) =>
            contract.call(RPC.sessionSteer, params.workspace, compactTurnParams(params)),
        sessionFollowUp: (params) =>
            contract.call(RPC.sessionFollowUp, params.workspace, compactTurnParams(params)),
    };
}
