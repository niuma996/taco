/**
 * commandPermission.resolve handler — isolated from the session domain.
 *
 * Resolves permission requests with optional global rule persistence.
 */

import type { CommandPermissionResolveParams } from "@taco-ai/protocol";
import { commandPermissionResolveSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import { saveGlobalConfig } from "../../config/config.ts";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

export function registerCommandPermissionHandlers(): void {
    registerMethod(
        RPC.commandPermissionResolve,
        true,
        async ({ workspace, params }: MethodCtx<CommandPermissionResolveParams>) => {
            const request = workspace.permissionBroker.getRequest(params.requestId);
            if (
                params.approved &&
                params.scope === "global" &&
                request &&
                request.evaluation.matchedList !== "deny"
            ) {
                if (request.evaluation.persistentAllowed !== false) {
                    try {
                        saveGlobalConfig({
                            commandPermissionsEdit: { addAllow: [request.command] },
                        });
                    } catch (e) {
                        workspace.permissionBroker.resolve(params.requestId, false, "once");
                        throw e;
                    }
                }
            }

            const resolved =
                workspace.permissionBroker.resolve(
                    params.requestId,
                    params.approved,
                    params.scope,
                ) !== undefined;
            return { resolved };
        },
        { command: true, schema: commandPermissionResolveSchema },
    );
}
