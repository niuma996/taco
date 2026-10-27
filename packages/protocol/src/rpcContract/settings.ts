/**
 * RPC contract rows — settings.* / config.* / providers.* — global configuration and provider catalog.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type {
    ConfigPatchParams,
    ConfigPatchResult,
    ExtensionsStatusParams,
    ExtensionsStatusResult,
    SettingsGetParams,
    SettingsGetResult,
    SettingsWriteParams,
    SettingsWriteResult,
} from "../config.js";
import {
    configPatchSchema,
    extensionsStatusSchema,
    providerListModelsSchema,
    providersListSchema,
    providersRevealKeySchema,
    providerTestConnectionSchema,
    settingsGetSchema,
    settingsWriteSchema,
} from "../schemas/index.js";
import type {
    ProviderListModelsParams,
    ProviderListModelsResult,
    ProvidersListParams,
    ProvidersListResult,
    ProvidersRevealKeyParams,
    ProvidersRevealKeyResult,
    ProviderTestConnectionParams,
    ProviderTestConnectionResult,
} from "../session.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const settingsRows = {
    providersList: row<ProvidersListParams, ProvidersListResult>()(
        "providers.list",
        "workspace",
        providersListSchema,
    ),
    providersRevealKey: row<ProvidersRevealKeyParams, ProvidersRevealKeyResult>()(
        "providers.revealKey",
        "workspace",
        providersRevealKeySchema,
    ),
    providerListModels: row<ProviderListModelsParams, ProviderListModelsResult>()(
        "provider.listModels",
        "process",
        providerListModelsSchema,
    ),
    providerTestConnection: row<ProviderTestConnectionParams, ProviderTestConnectionResult>()(
        "provider.testConnection",
        "process",
        providerTestConnectionSchema,
    ),
    settingsGet: row<SettingsGetParams, SettingsGetResult>()(
        "settings.get",
        "process",
        settingsGetSchema,
    ),
    settingsWrite: row<SettingsWriteParams, SettingsWriteResult>()(
        "settings.write",
        "process",
        settingsWriteSchema,
    ),
    configPatch: row<ConfigPatchParams, ConfigPatchResult>()(
        "config.patch",
        "workspace",
        configPatchSchema,
    ),
    extensionsStatus: row<ExtensionsStatusParams, ExtensionsStatusResult>()(
        "extensions.status",
        "process",
        extensionsStatusSchema,
    ),
};

export const settingsMethods = domainMethods(settingsRows);
export const settingsContract = domainContract(settingsRows);
export const settingsSchemas = domainSchemas(settingsRows);
