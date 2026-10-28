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

import type { ConfigPatchResult, GlobalConfigPatch } from "@taco-ai/protocol";
import { asSessionId, ErrorCodes, IM_CWD_PREFIX } from "@taco-ai/protocol";
import { createLogger } from "../../lib/logger.ts";
import { patchFields } from "../../tools/config.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";
import { applyGlobalConfigPatch } from "./settings.ts";

const log = createLogger("config");

export function registerConfigHandlers(): void {
    registerMethod(
        "configPatch",
        true,
        async ({ cwd, workspace, params, server }): Promise<ConfigPatchResult> => {
            // Defense-in-depth for the configPatch tool's own main-session
            // check: the RPC is also reachable from any client with a
            // dispatcher, so re-verify the claimed workspace is local and the
            // session is main-kind there. The workspace param is
            // caller-supplied routing (as in every method) — the binding
            // barrier against a hostile caller remains the user approval
            // below, not this check.
            const { sessionId } = params;
            if (sessionId.trim() === "") {
                // The schema allows any minLength-1 string; " " would make
                // asSessionId throw a TypeError that surfaces as an internal
                // error instead of a parameter problem.
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "config.patch: sessionId must be a non-empty string",
                );
            }
            if (
                cwd.startsWith(IM_CWD_PREFIX) ||
                workspace.getSessionKind(asSessionId(sessionId)) !== "main"
            ) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidState,
                    "config.patch: global configuration can only be changed from a local main session",
                );
            }

            const patch = params.patch as GlobalConfigPatch;
            const fields = patchFields(patch);
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
                const global = await applyGlobalConfigPatch(server, patch);
                log.info(`config patched: ${fields.join(", ")}`);
                return { approved: true, fields, global };
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidValue,
                    e instanceof Error ? e.message : "config.patch failed",
                );
            }
        },
    );
}
