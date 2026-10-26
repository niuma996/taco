/**
 * catalog handlers — listModels, providers.list, providers.revealKey.
 *
 * Workspace-scoped queries over the model/provider catalog. They do not
 * touch an attached session or the harness turn loop.
 */

import { ErrorCodes } from "@taco-ai/protocol";

import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

export function registerCatalogHandlers(): void {
    registerMethod("sessionListModels", true, async ({ workspace, params }) => {
        return { models: workspace.listAvailableModels(params.provider) };
    });

    registerMethod("providersList", true, async ({ workspace }) => {
        return { providers: workspace.listConfiguredProviders() };
    });

    // Returns the plaintext key for one provider. The key already lives in
    // plaintext in taco.json on the same machine, so the reveal RPC keeps
    // parity with the on-disk trust boundary — but it must never be logged
    // or echoed into other frames.
    registerMethod("providersRevealKey", true, async ({ server, params }) => {
        const { providerId } = params;
        if (typeof providerId !== "string" || providerId.trim() === "") {
            throw new RpcHandlerError(ErrorCodes.InvalidParams, "providerId is required");
        }
        return { key: server.providerKeyStore.get(providerId) ?? null };
    });
}
