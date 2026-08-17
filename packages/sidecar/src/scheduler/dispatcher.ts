/**
 * dispatcher.ts — routes scheduled job fires to the SidecarServer RPC layer.
 *
 * The scheduler fires callbacks without a live workspace context, so the
 * command cannot go through the normal `MethodCtx` / workspace-coupled
 * handler registry. Instead, this module talks directly to
 * `SidecarServer.dispatchRpc` using the `session.create` +
 * `initialPrompt` pattern: a single call creates the session and runs the
 * first turn atomically, avoiding any create→prompt race window if the
 * process exits between them.
 */

import { randomUUID } from "node:crypto";
import type { RpcRequest, RpcResponse } from "@taco-ai/protocol";

/** Minimal surface the dispatcher needs from SidecarServer. Kept narrow
 *  so tests can stub it without dragging in the full ServerRpcSurface. */
interface DispatchSurface {
    dispatchRpc(req: RpcRequest): Promise<RpcResponse>;
}

export class UnsupportedScheduledCommand extends Error {
    constructor(command: string) {
        super(`unsupported scheduled command: ${command}`);
        this.name = "UnsupportedScheduledCommand";
    }
}

export class ScheduledCommandFailed extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ScheduledCommandFailed";
    }
}

export type JobCommandInvoker = (command: string, args: Record<string, unknown>) => Promise<void>;

export function createJobDispatcher(server: DispatchSurface): JobCommandInvoker {
    return async (command, args) => {
        const workspace = typeof args.workspace === "string" ? args.workspace : "*";
        switch (command) {
            case "agent.invoke": {
                const prompt = String(args.prompt ?? "");
                if (!prompt) {
                    throw new Error("agent.invoke requires args.prompt");
                }
                const id = `sched-${randomUUID()}`;
                // session.create runs the first turn when initialPrompt is set
                // (see packages/protocol/src/session.ts:155) — creating + running
                // in one wire call avoids the create→prompt race window if the
                // scheduler dies between them.
                const res = await server.dispatchRpc({
                    id,
                    method: "session.create",
                    params: { workspace, sessionId: id, initialPrompt: prompt },
                });
                if (!res.ok) {
                    throw new ScheduledCommandFailed(res.error.code, res.error.message);
                }
                return;
            }
            default:
                throw new UnsupportedScheduledCommand(command);
        }
    };
}
