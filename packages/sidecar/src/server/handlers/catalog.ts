/**
 * catalog handlers — listModels, providers.list.
 *
 * Workspace-scoped queries over the model/provider catalog. They do not
 * touch an attached session or the harness turn loop.
 */

import type { ListModelsParams, ProvidersListParams } from "@taco-ai/protocol";
import { providersListSchema, sessionListModelsSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";

import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

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
}
