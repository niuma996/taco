/**
 * RPC contract rows — settings.* / config.* / providers.* — global configuration and provider catalog.
 *
 * Three tables move together: the wire name, the params/result types, and the
 * params schema. `rpcContract/index.ts` merges them into the single
 * `RPC` / `rpcContract` / `rpcSchemas` exports that the client and the
 * sidecar both read.
 *
 * Adding a method to this domain means adding one entry to each of the three
 * tables below — the compile-time assertions in the index catch a row that
 * was added to one and forgotten in another.
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
import type { RpcContractRow } from "./types.js";

/** Wire names for this domain. */
export const settingsMethods = {
    providersList: "providers.list",
    /** Return one provider's plaintext API key (settings UI "reveal" toggle). */
    providersRevealKey: "providers.revealKey",
    providerListModels: "provider.listModels",
    /** Send one minimal chat turn to verify key + endpoint + protocol + model id. */
    providerTestConnection: "provider.testConnection",
    // settings.*
    settingsGet: "settings.get",
    settingsWrite: "settings.write",
    // config.* — the model's view of the global config. `config.patch` asks
    // the user before writing; `settings.write` is the desktop's own path
    // and needs no approval.
    configPatch: "config.patch",
    // extensions.*
    extensionsStatus: "extensions.status",
    // channels.* — IM channel listing / binding.
} as const;

/** Params/result types and routing scope for this domain. */
export const settingsContract = {
    settingsGet: { scope: "process" } as RpcContractRow<
        SettingsGetParams,
        SettingsGetResult,
        "process"
    >,
    settingsWrite: { scope: "process" } as RpcContractRow<
        SettingsWriteParams,
        SettingsWriteResult,
        "process"
    >,
    configPatch: { scope: "workspace" } as RpcContractRow<
        ConfigPatchParams,
        ConfigPatchResult,
        "workspace"
    >,
    extensionsStatus: { scope: "process" } as RpcContractRow<
        ExtensionsStatusParams,
        ExtensionsStatusResult,
        "process"
    >,
    providersList: { scope: "workspace" } as RpcContractRow<
        ProvidersListParams,
        ProvidersListResult,
        "workspace"
    >,
    providersRevealKey: { scope: "workspace" } as RpcContractRow<
        ProvidersRevealKeyParams,
        ProvidersRevealKeyResult,
        "workspace"
    >,
    providerListModels: { scope: "process" } as RpcContractRow<
        ProviderListModelsParams,
        ProviderListModelsResult,
        "process"
    >,
    providerTestConnection: { scope: "process" } as RpcContractRow<
        ProviderTestConnectionParams,
        ProviderTestConnectionResult,
        "process"
    >,
};

/** Params schemas for this domain. */
export const settingsSchemas = {
    settingsGet: settingsGetSchema,
    settingsWrite: settingsWriteSchema,
    configPatch: configPatchSchema,
    extensionsStatus: extensionsStatusSchema,
    providersList: providersListSchema,
    providersRevealKey: providersRevealKeySchema,
    providerListModels: providerListModelsSchema,
    providerTestConnection: providerTestConnectionSchema,
};
