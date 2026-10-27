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
 */

import type {
    CommandPermissionDenialReason,
    CustomProviderApi,
    ExtensionPermission,
    ExtensionSource,
    McpServerConfig,
    McpServerConfigView,
    McpTransportKind,
    TacoGlobalConfigView,
} from "../config.js";
import {
    commandPermissionResolveSchema,
    configPatchSchema,
    extensionsStatusSchema,
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
    settingsWriteSchema,
} from "../schemas/settings.js";
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

/** `providers.list` RPC params. */
export type ProvidersListParams = ParamsOf<typeof providersListSchema>;

/** Provider availability view (one entry in `providers.list` result). */
export interface ProviderView {
    id: string;
    name: string;
    /** Whether a key is configured. */
    configured: boolean;
    /** Whether this is a user-defined provider. */
    custom: boolean;
    /**
     * Endpoint base URL. Read-only for built-ins (their catalog is fixed by
     * pi); editable through the custom-provider config for customs.
     */
    baseUrl?: string;
    /** Protocol family. Read-only for built-ins, like baseUrl. */
    api?: CustomProviderApi;
    /** Models available under this provider. */
    models: Array<{
        provider: string;
        id: string;
        name?: string;
        /**
         * Provenance: "builtin" = pi static list (read-only in the UI),
         * "extra" = user-added on a built-in provider (removable),
         * "custom" = belongs to a custom provider (editable via that provider),
         * "hidden" = a static model the user removed; still listed so the
         * settings UI can offer a restore action.
         */
        origin?: "builtin" | "extra" | "custom" | "hidden";
        /**
         * Context window in tokens. A user-added model carries the value the
         * user declared; a catalog model carries pi's own. Absent when the
         * model declares none.
         */
        contextWindow?: number;
        /** Per-output cap in tokens. Absent when the model declares none. */
        maxTokens?: number;
        /**
         * Whether the model reasons before answering, as the user declared it
         * for an added model. Absent means the provider's default applies.
         */
        reasoning?: boolean;
    }>;
}

/** `providers.list` RPC result — built-in + custom provider availability. */
export interface ProvidersListResult {
    providers: ProviderView[];
}

/** `providers.revealKey` RPC params — returns the plaintext key for one provider. */
export type ProvidersRevealKeyParams = ParamsOf<typeof providersRevealKeySchema>;

/** `providers.revealKey` RPC result — `null` when no key is configured. */
export interface ProvidersRevealKeyResult {
    key: string | null;
}

/**
 * `provider.listModels` RPC params.
 *
 * Two shapes:
 * - `endpoint`: fetch `{baseUrl}/models` with the literal key the user typed
 *   (custom-provider form — the store has not been written yet).
 * - `saved`: resolve baseUrl/api from the registered provider (built-in table
 *   or customProviders) and the key from the sidecar's ProviderKeyStore, so
 *   plaintext keys never cross the wire for already-saved providers.
 */
export type ProviderListModelsParams = ParamsOf<typeof providerListModelsSchema>;

/**
 * Discriminated result — either a model id list or why the probe failed.
 * `message` is human-readable and safe to surface verbatim (no API key).
 */
export type ProviderListModelsResult =
    | { ok: true; models: string[] }
    | {
          ok: false;
          reason: ProviderListModelsFailureReason;
          message: string;
      };

/**
 * `provider.testConnection` RPC params — sends one minimal chat turn through
 * the same pi streaming path a session uses, so a pass means key, endpoint,
 * protocol and model id all work together.
 *
 * Two shapes, mirroring `provider.listModels`:
 * - `{ providerId, modelId, apiKey? }` — a saved provider. The key comes from
 *   the sidecar's store unless `apiKey` is given (a key typed but not yet
 *   saved), so stored keys never cross the wire.
 * - `{ baseUrl, api, apiKey, modelId }` — the create-custom form, before any
 *   provider is registered.
 */
export type ProviderTestConnectionParams = ParamsOf<typeof providerTestConnectionSchema>;

/**
 * `provider.testConnection` result. Probe failures are a normal outcome, not
 * an RPC error: the RPC itself only rejects on malformed params.
 * `message` is human-readable and safe to surface verbatim (no API key).
 */
export type ProviderTestConnectionResult =
    | {
          ok: true;
          /** Round-trip time of the probe, in milliseconds. */
          latencyMs: number;
          /** The model that answered — echoes `responseModel` when the upstream reports one. */
          model: string;
          /** First characters of the reply, for a visual sanity check. */
          reply: string;
      }
    | {
          ok: false;
          reason: ProviderTestConnectionFailureReason;
          message: string;
          latencyMs: number;
      };

/**
 * Why a connection test failed. `auth` and `not-found` are split out from
 * `http-error` because they map to different fixes (check the key vs. check
 * the model id / endpoint); everything else unclassified is `error`.
 */
export type ProviderTestConnectionFailureReason =
    | "auth"
    | "not-found"
    | "rate-limited"
    | "timeout"
    | "network"
    | "error";

/**
 * Why a `provider.listModels` probe failed.
 *
 * `protocol-not-supported` is deprecated: since protocol 2.2 every protocol
 * shares the same `{baseUrl}/models` catalog, so the current sidecar never
 * returns it. It stays in the union because the type is published and pre-2.2
 * daemons still emit it — clients should treat it like any other failure and
 * show `message`.
 */
export type ProviderListModelsFailureReason =
    | "http-error"
    | "timeout"
    | "invalid-response"
    /** @deprecated Not emitted since protocol 2.2; see ProviderListModelsFailureReason. */
    | "protocol-not-supported";

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
