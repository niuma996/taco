/**
 * RPC contract rows — settings.* / config.* / providers.* — global configuration and provider catalog.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type {
    ConfigPatchResult,
    ExtensionsStatusResult,
    SettingsGetResult,
    SettingsWriteResult,
} from "../config.js";
import { configPatchSchema, settingsWriteSchema } from "../schemas/globalConfig.js";
import {
    extensionsStatusSchema,
    providerListModelsSchema,
    providersListSchema,
    providersRevealKeySchema,
    providerTestConnectionSchema,
    settingsGetSchema,
} from "../schemas/index.js";
import type {
    ProviderListModelsResult,
    ProvidersListResult,
    ProvidersRevealKeyResult,
    ProviderTestConnectionResult,
} from "../session.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const settingsRows = {
    providersList: row<ProvidersListResult>()("providers.list", "workspace", providersListSchema),
    providersRevealKey: row<ProvidersRevealKeyResult>()(
        "providers.revealKey",
        "workspace",
        providersRevealKeySchema,
    ),
    providerListModels: row<ProviderListModelsResult>()(
        "provider.listModels",
        "process",
        providerListModelsSchema,
    ),
    providerTestConnection: row<ProviderTestConnectionResult>()(
        "provider.testConnection",
        "process",
        providerTestConnectionSchema,
    ),
    settingsGet: row<SettingsGetResult>()("settings.get", "process", settingsGetSchema),
    settingsWrite: row<SettingsWriteResult>()("settings.write", "process", settingsWriteSchema),
    configPatch: row<ConfigPatchResult>()("config.patch", "workspace", configPatchSchema),
    extensionsStatus: row<ExtensionsStatusResult>()(
        "extensions.status",
        "process",
        extensionsStatusSchema,
    ),
};

export const settingsMethods = domainMethods(settingsRows);
export const settingsContract = domainContract(settingsRows);
export const settingsSchemas = domainSchemas(settingsRows);
