/**
 * command_permission.resolve handler — isolated from the session domain.
 *
 * Resolves permission requests with optional global rule persistence.
 */

import type { CommandPermissionResolveParams } from "@taco-ai/protocol";
import { commandPermissionResolveSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import {
    readGlobalConfig,
    saveGlobalConfig,
    validateCommandPermissions,
} from "../../config/config.ts";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

export function registerCommandPermissionHandlers(): void {
    registerMethod(
        RPC.commandPermissionResolve,
        true,
        async ({ workspace, params }: MethodCtx<CommandPermissionResolveParams>) => {
            const request = workspace.permissionBroker.getRequest(params.requestId);
            if (params.approved && params.scope === "global" && request) {
                const current = validateCommandPermissions(
                    readGlobalConfig().commandPermissions,
                    "taco.json",
                );
                if (!current.rules.some((rule) => rule === request.command)) {
                    try {
                        await saveGlobalConfig({
                            commandPermissions: {
                                ...current,
                                rules: [...current.rules, request.command],
                            },
                        });
                    } catch (e) {
                        // Persisting the global rule failed; do not leave the shell
                        // waiting. Resolve the request as a one-time denial so the
                        // caller gets feedback, then surface the original error.
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
