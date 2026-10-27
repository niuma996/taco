/** Type-safe boundary between ergonomic client facades and raw transports. */
import type {
    ProcessScopedKey,
    RPC,
    RpcMethodParams,
    RpcMethodResult,
    WorkspaceId,
    WorkspaceScopedKey,
} from "@taco-ai/protocol";
/**
 * Raw transport interface implemented by Node and desktop clients.
 * Kept here so the facade can depend on this module without a cycle.
 */
export interface RpcDispatch {
    call<TParams = void, TResult = unknown>(
        method: string,
        workspace: WorkspaceId,
        params: TParams,
    ): Promise<TResult>;
    callProcess<TParams = void, TResult = unknown>(
        method: string,
        params: TParams,
    ): Promise<TResult>;
}

type WorkspaceMethod = (typeof RPC)[WorkspaceScopedKey];
type ProcessMethod = (typeof RPC)[ProcessScopedKey];

export function createProcessContractDispatch(dispatch: Pick<RpcDispatch, "callProcess">) {
    return {
        callProcess<M extends ProcessMethod>(
            method: M,
            params: NoInfer<RpcMethodParams<M>>,
        ): Promise<RpcMethodResult<M>> {
            return dispatch.callProcess<RpcMethodParams<M>, RpcMethodResult<M>>(method, params);
        },
    };
}

export function createContractDispatch(dispatch: RpcDispatch) {
    return {
        ...createProcessContractDispatch(dispatch),
        call<M extends WorkspaceMethod>(
            method: M,
            workspace: WorkspaceId,
            params: NoInfer<RpcMethodParams<M>>,
        ): Promise<RpcMethodResult<M>> {
            return dispatch.call<RpcMethodParams<M>, RpcMethodResult<M>>(method, workspace, params);
        },
    };
}
