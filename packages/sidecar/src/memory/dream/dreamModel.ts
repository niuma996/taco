/**
 * Model resolution for the process-level dream job.
 *
 * The job runs outside any workspace, so it cannot borrow a WorkspaceRuntime's
 * catalog. It builds its own on each fire from the live global config, so a
 * provider or default-model change in Settings applies to the next run
 * without a daemon restart. Credentials come from the daemon's shared
 * ProviderKeyStore, which `settings.write` already hot-reloads.
 */

import { createModels } from "@earendil-works/pi-ai/compat";
import { readGlobalConfig } from "../../config/config.ts";
import { findModelById } from "../../runtime/models/modelLookup.ts";
import { applyBuiltinProviders } from "../../runtime/models/modelRegistry.ts";
import type { ProviderKeyStore } from "../../runtime/models/providerKeyStore.ts";
import type { Api, Model, Models } from "../../runtime/pi/types.ts";

/**
 * Resolve the configured default model. Returns undefined when it does not
 * resolve — the job then fails visibly instead of silently consolidating with
 * an arbitrary first-in-catalog model.
 */
export function resolveDreamModel(
    keys: ProviderKeyStore,
): { models: Models; model: Model<Api> } | undefined {
    const cfg = readGlobalConfig();
    const models = createModels({ credentials: keys });
    applyBuiltinProviders(
        models,
        undefined,
        cfg.customProviders ?? [],
        cfg.providerExtraModels ?? {},
        cfg.providerHiddenModels ?? {},
    );
    const lookup = (provider: string | undefined, id: string): Model<Api> | undefined =>
        provider
            ? (models.getModel(provider, id) as Model<Api> | undefined)
            : findModelById(models, id);

    if (!cfg.defaultModel) return undefined;
    const model = lookup(cfg.defaultProvider, cfg.defaultModel);
    return model ? { models, model } : undefined;
}
