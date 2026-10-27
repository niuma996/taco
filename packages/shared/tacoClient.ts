/**
 * @taco-ai/shared — protocol client layer usable from both Node and the browser.
 *
 * This barrel exports nothing that depends on `node:` built-ins. Node-only
 * client implementations live in `./tacoClientNode.ts`; default spawn is at
 * `@taco-ai/shared/spawn`. Do not pull spawn symbols from this barrel, or
 * vite will bundle `node:child_process` into the browser.
 */

export {
    createContractDispatch,
    createProcessContractDispatch,
    type RpcDispatch,
} from "./contractDispatch.js";
export { FrameDispatcher, NdjsonLineBuffer, RpcRemoteError } from "./dispatcher.js";
export {
    FAST_RPC_METHODS,
    FAST_RPC_TIMEOUT_MS,
    RPC,
    type RpcMethodName,
} from "./rpcMethods.js";
export { TacoClientBase } from "./tacoClientBase.js";
export { createTypedRpc, type TypedRpc } from "./typedRpc.js";
