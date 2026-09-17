/**
 * Shared tool context — what the harness injects as a tool's `toolContext`
 * argument, so tools read per-turn state (workspace, self-RPC entry, optional
 * actor) without taking it as a constructor arg. Replaces the previous
 * `MemoryToolDeps` / `JobsToolDeps` closure pattern — the LLM no longer has to
 * thread workspace / actor / call through the schema.
 *
 * `env` is pi's built-in `ExecutionToolContext.env`; merged in here so tools
 * that need the fs shell share one context with tools that need self-RPC.
 *
 * pi calls `execute(toolCallId, params, onUpdate, toolContext, invocation,
 * context)`, and a tool declares only the parameters it consumes. Params 5/6
 * are needed only for replay memos (`invocation`) or cancellation
 * (`context.abortSignal` — pi strips the signal from `toolContext`); they are
 * declared `unknown` when they exist only to reach a later position.
 */

import type { WorkspaceId } from "@taco-ai/protocol";
import type { NodeExecutionEnv } from "../runtime/pi/node.ts";
import type { Actor } from "../scheduler/types.ts";

/**
 * In-process self-RPC outbound. Mirrors the shape of every cross-process
 * `call(client, method, params)` so the tool layer is identical for both.
 * `workspace` is included for parity with the wire surface even though
 * today every tool passes the session's own cwd.
 */
export type SelfRpcCall = <P, R>(method: string, workspace: WorkspaceId, params: P) => Promise<R>;

export interface TacoToolContext {
    /** pi execution env (fs + shell). Required — read / write / shell read it. */
    env: NodeExecutionEnv;
    /** Session cwd — every self-RPC call's `workspace` parameter. */
    workspace: WorkspaceId;
    /** In-process self-RPC entry. `undefined` when the workspace has no
     *  dispatchRpc (admin / tests) — tools that need it skip themselves. */
    call?: SelfRpcCall;
    /** Scope identity for jobs.* RPCs. `undefined` disables scope enforcement
     *  (admin / test workspaces); JobsController treats undefined actor as
     *  "see everything". */
    actor?: Actor;
}
