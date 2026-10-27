/**
 * RPC contract rows — settings.* / config.* / mcp.* / providers.* /
 * extensions.* / commandPermission.* — the global configuration surface.
 *
 * The rows, their schemas and their request/result types all live here, so
 * a method's whole contract is one file. `config.ts` keeps only the on-disk
 * config shape; `configPatch.ts` keeps the open-body patch types.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 *
 * The request and result types live here next to the rows that use them;
 * `config.ts` keeps only the on-disk config shape and its views.
 */

import type {
    CommandPermissionDenialReason,
    ExtensionPermission,
    ExtensionSource,
    McpServerConfig,
    McpServerConfigView,
    McpTransportKind,
    TacoGlobalConfigView,
} from "../config.js";
import { commandPermissionResolveSchema } from "../schemas/commandPermission.js";
import { extensionsStatusSchema } from "../schemas/extensions.js";
import { configPatchSchema, settingsWriteSchema } from "../schemas/globalConfig.js";
import {
    mcpCreateConfigSchema,
    mcpDeleteConfigSchema,
    mcpGetConfigSchema,
    mcpListServersSchema,
    mcpUpdateConfigSchema,
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
import type { ParamsOf } from "./types.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

export type CommandPermissionResolveParams = ParamsOf<typeof commandPermissionResolveSchema>;

export interface CommandPermissionResolveResult {
    resolved: boolean;
}

/**
 * Per-server health snapshot returned by `mcp.listServers`.
 *
 * - `status: "ok"`     — the server connected and listTools succeeded.
 * - `status: "error"`  — connect or listTools failed; `connectError` carries the reason.
 * - `status: "skipped"` — the server is `enabled: false` and the handler chose
 *                        not to spawn it (see `mcp.listServers` for the policy).
 *                        `tools` is empty and `connectError` is undefined.
 */
export interface McpServerView {
    id: string;
    transport: McpTransportKind;
    status: "ok" | "error" | "skipped";
    /** Number of tools exposed by this server. */
    toolCount: number;
    /** Raw tool names, in the order returned by the server. */
    tools: string[];
    /** Set when status === "error"; undefined otherwise. */
    connectError?: string;
}

export interface McpListServersResult {
    servers: McpServerView[];
}

/** `mcp.listServers` params — which servers to probe, and whether to force a probe. */
export type McpListServersParams = ParamsOf<typeof mcpListServersSchema>;

/** `mcp.getConfig` params — fetch one raw MCP server config for editing. */
export type McpGetConfigParams = ParamsOf<typeof mcpGetConfigSchema>;

export interface McpGetConfigResult {
    config: McpServerConfig;
}

export type McpCreateConfigParams = ParamsOf<typeof mcpCreateConfigSchema>;

/** Shared result for create / update — safe summary + restart requirement. */
export interface McpMutateConfigResult {
    server: McpServerConfigView;
    requiresRestart: true;
}

export type McpUpdateConfigParams = ParamsOf<typeof mcpUpdateConfigSchema>;

export type McpDeleteConfigParams = ParamsOf<typeof mcpDeleteConfigSchema>;

export interface McpDeleteConfigResult {
    deleted: string;
    requiresRestart: true;
}

/** `settings.get` RPC params (currently no required input; reserved for future). */
export type SettingsGetParams = ParamsOf<typeof settingsGetSchema>;

/** `settings.get` RPC result — sidecar global config view (key fields masked, never plaintext). */
export interface SettingsGetResult {
    /** From the sidecar process (reads ~/.taco/taco.json); key fields are masked. */
    global: TacoGlobalConfigView;
}

/** `settings.write` RPC result — latest view after write-back (key fields masked). */
export interface SettingsWriteResult {
    /** Sidecar global config view after write-back; key fields are masked. */
    global: TacoGlobalConfigView;
}

/** `config.patch` RPC result. */
export interface ConfigPatchResult {
    /** True when the user approved the change and it was written. */
    approved: boolean;
    /** The config fields the patch touched. */
    fields: string[];
    /**
     * Why the change was not approved. Absent when `approved` is true.
     *
     * The tool turns this into guidance, and the difference matters: a
     * `user_denied` means the user said no (do not retry, do not work around
     * it), while `timeout` or `no_approver` means nobody answered (ask, or
     * tell the user to approve it in the desktop app).
     */
    denialReason?: CommandPermissionDenialReason;
    /** Config view after the write (masked). Absent when declined. */
    global?: TacoGlobalConfigView;
}

/** `extensions.status` RPC — returns the current extension registry's status. */
export type ExtensionsStatusParams = ParamsOf<typeof extensionsStatusSchema>;

export interface ExtensionStatusEntry {
    name: string;
    version: string;
    source: ExtensionSource;
    permissions: ReadonlyArray<ExtensionPermission>;
    /** Short description ("what it does"), from manifest `taco.description`. May be absent. */
    description?: string;
    /** Activation hint ("when to use"), from manifest `taco.whenToUse`. May be absent. */
    whenToUse?: string;
    /** Tag names registered by this extension via `registerTag`. Only populated for loaded entries. */
    tags?: ReadonlyArray<string>;
}

export interface ExtensionsStatusResult {
    loaded: ExtensionStatusEntry[];
    failed: Array<{ name: string; reason: string }>;
    unauthorized: Array<{ name: string; method: string }>;
    /**
     * Extension names disabled via `disabledExtensions` and therefore not
     * loaded. Only the name is exposed — disabled = not loaded = manifest
     * unread, so version/permissions/description are unavailable. Mutually
     * exclusive with `loaded`/`failed`/`unauthorized` (the loader routes
     * them at the subtraction step).
     */
    disabled: string[];
}

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
    commandPermissionResolve: row<CommandPermissionResolveResult>()(
        "commandPermission.resolve",
        "workspace",
        commandPermissionResolveSchema,
    ),
    mcpListServers: row<McpListServersResult>()("mcp.listServers", "process", mcpListServersSchema),
    mcpGetConfig: row<McpGetConfigResult>()("mcp.getConfig", "process", mcpGetConfigSchema),
    mcpCreateConfig: row<McpMutateConfigResult>()(
        "mcp.createConfig",
        "process",
        mcpCreateConfigSchema,
    ),
    mcpUpdateConfig: row<McpMutateConfigResult>()(
        "mcp.updateConfig",
        "process",
        mcpUpdateConfigSchema,
    ),
    mcpDeleteConfig: row<McpDeleteConfigResult>()(
        "mcp.deleteConfig",
        "process",
        mcpDeleteConfigSchema,
    ),
};

export const settingsMethods = domainMethods(settingsRows);
export const settingsContract = domainContract(settingsRows);
export const settingsSchemas = domainSchemas(settingsRows);
