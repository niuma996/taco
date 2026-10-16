/**
 * catalog handlers — listModels, providers.list, providers.revealKey.
 *
 * Workspace-scoped queries over the model/provider catalog. They do not
 * touch an attached session or the harness turn loop.
 */

import type {
    ListModelsParams,
    ProvidersListParams,
    ProvidersRevealKeyParams,
} from "@taco-ai/protocol";
import {
    ErrorCodes,
    providersListSchema,
    providersRevealKeySchema,
    sessionListModelsSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

export function registerCatalogHandlers(): void {
    registerMethod(
        RPC.sessionListModels,
        true,
        async ({ workspace, params }: MethodCtx<ListModelsParams>) => {
            return { models: workspace.listAvailableModels(params.provider) };
        },
        { schema: sessionListModelsSchema },
    );

    registerMethod(
        RPC.providersList,
        true,
        async ({ workspace }: MethodCtx<ProvidersListParams>) => {
            return { providers: workspace.listConfiguredProviders() };
        },
        { schema: providersListSchema },
    );

    // Returns the plaintext key for one provider. The key already lives in
    // plaintext in taco.json on the same machine, so the reveal RPC keeps
    // parity with the on-disk trust boundary — but it must never be logged
    // or echoed into other frames.
    registerMethod(
        RPC.providersRevealKey,
        true,
        async ({ server, params }: MethodCtx<ProvidersRevealKeyParams>) => {
            const { providerId } = params;
            if (typeof providerId !== "string" || providerId.trim() === "") {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "providerId is required");
            }
            return { key: server.providerKeyStore.get(providerId) ?? null };
        },
        { schema: providersRevealKeySchema },
    );
}
