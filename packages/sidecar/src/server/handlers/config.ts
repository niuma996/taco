/**
 * config.* handler — the model's path to the global taco configuration.
 *
 * `config.patch` is where a model-proposed config change becomes a real
 * write. The approval lives HERE, not in the tool: a config change can
 * disable the very approvals that would review it, so the write must not be
 * reachable without one. A tool that asked for approval and then wrote
 * separately would leave a gap between the two.
 *
 * The desktop's own path is `settings.write` — the user is already at the
 * settings pane, so no approval is needed there. Both land through the same
 * write helper, so a change takes effect the same way whichever path it came
 * from.
 */

import type { ConfigPatchParams, ConfigPatchResult, GlobalConfigPatch } from "@taco-ai/protocol";
import { configPatchSchema, ErrorCodes } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { createLogger } from "../../lib/logger.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { applyGlobalConfigPatch } from "./settings.ts";

const log = createLogger("config");

export function registerConfigHandlers(): void {
    registerMethod(
        RPC.configPatch,
        true,
        async ({
            workspace,
            params,
            server,
            serverRegistry,
        }: MethodCtx<ConfigPatchParams>): Promise<ConfigPatchResult> => {
            const patch = params.patch as GlobalConfigPatch;
            const fields = Object.keys(patch).filter(
                (key) => patch[key as keyof GlobalConfigPatch] !== undefined,
            );
            if (fields.length === 0) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "config.patch: the patch touches no fields",
                );
            }

            // A config change is a permission grant in the other direction: it
            // can widen what later commands are allowed to do. So it asks, and
            // the scope is "once" only — a stored rule would let a later turn
            // widen its own permissions without asking again.
            const decision = await workspace.permissionBroker.requestConfigApproval({
                sessionId: params.sessionId,
                toolCallId: params.toolCallId,
                fields,
            });
            if (!decision.approved) {
                // The reason travels with the result: the tool turns it into
                // guidance, and "the user said no" and "nobody answered" call
                // for different behaviour.
                return { approved: false, fields, denialReason: decision.denialReason };
            }

            try {
                const global = applyGlobalConfigPatch(server, serverRegistry, patch);
                log.info(`config patched: ${fields.join(", ")}`);
                return { approved: true, fields, global };
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidValue,
                    e instanceof Error ? e.message : "config.patch failed",
                );
            }
        },
        { schema: configPatchSchema },
    );
}
