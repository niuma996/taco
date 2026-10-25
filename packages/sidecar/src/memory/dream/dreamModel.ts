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
import { applyBuiltinProviders, findModelById } from "../../runtime/models/modelRegistry.ts";
import type { ProviderKeyStore } from "../../runtime/models/providerKeyStore.ts";
import type { Api, Model, Models } from "../../runtime/pi/types.ts";

/**
 * Resolve `override` (job args.model: `provider/id` or bare id), else the
 * configured default model. Returns undefined when neither resolves — the
 * job then fails visibly instead of silently consolidating with an
 * arbitrary first-in-catalog model.
 */
export function resolveDreamModel(
    keys: ProviderKeyStore,
    override?: string,
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

    if (override) {
        const slash = override.indexOf("/");
        const model =
            slash > 0
                ? lookup(override.slice(0, slash), override.slice(slash + 1))
                : lookup(undefined, override);
        return model ? { models, model } : undefined;
    }
    if (!cfg.defaultModel) return undefined;
    const model = lookup(cfg.defaultProvider, cfg.defaultModel);
    return model ? { models, model } : undefined;
}
