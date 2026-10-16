/**
 * ModelRegistry — model switching + availability view.
 *
 * pi-native design: built-in providers stay in the catalog permanently;
 * "available" is determined at request time by whether a key can be lazily
 * resolved. Keys come from `ProviderKeyStore` by provider id; adding a key
 * takes effect immediately without rebuilding the catalog.
 *
 * Custom providers (via `buildCustomProvider`) also stay in the catalog.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";
import type {
    CustomModelEntry,
    CustomProviderApi,
    CustomProviderConfig,
    SessionId,
} from "@taco-ai/protocol";
import type { Api, Model } from "../pi/types.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import {
    buildCustomProvider,
    DEFAULT_CUSTOM_CONTEXT_WINDOW,
    DEFAULT_CUSTOM_MAX_TOKENS,
} from "./customProvider.ts";
import type { ProviderKeyStore } from "./providerKeyStore.ts";

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
    /** Provenance tag for the settings UI ("builtin" static / "extra" user-added / "custom" provider-owned / "hidden" removed static). */
    origin?: "builtin" | "extra" | "custom" | "hidden";
}

/** Per-provider availability view (used by the UI to render provider rows and filter models). */
export interface ProviderInfo {
    /** Provider id. */
    id: string;
    /** Display name. */
    name: string;
    /** Whether a key is configured. */
    configured: boolean;
    /** Whether this is a custom provider. */
    custom: boolean;
    /** Endpoint base URL — read-only for built-ins, shown in the settings UI. */
    baseUrl?: string;
    /** Protocol family — read-only for built-ins, shown in the settings UI. */
    api?: CustomProviderApi;
    /** Models under this provider. */
    models: ModelInfo[];
}

export interface BuiltinProviderEntry {
    readonly id: string;
    readonly name: string;
    readonly factory: () => Provider;
}

/**
 * Built-in provider factory table (curated set + popular CN ones, pure
 * API-key auth).
 *
 * To add a provider: append a row here. All entries stay registered
 * permanently — see "pi-native design" in the file header. Keys are
 * resolved through `ProviderKeyStore` (CredentialStore) by id; no env-var
 * name mapping needed (so google→GEMINI / moonshotai→MOONSHOT and similar
 * name-mismatch issues do not arise).
 */
export const BUILTIN_PROVIDER_FACTORIES: ReadonlyArray<BuiltinProviderEntry> = [
    { id: "anthropic", name: "Anthropic", factory: () => anthropicProvider() },
    { id: "openai", name: "OpenAI", factory: () => openaiProvider() },
    { id: "google", name: "Google Gemini", factory: () => googleProvider() },
    { id: "xai", name: "xAI (Grok)", factory: () => xaiProvider() },
    { id: "deepseek", name: "DeepSeek", factory: () => deepseekProvider() },
    { id: "moonshotai", name: "Moonshot (Kimi)", factory: () => moonshotaiProvider() },
    { id: "moonshotai-cn", name: "Moonshot CN (Kimi)", factory: () => moonshotaiCnProvider() },
    { id: "zai", name: "Z.AI (GLM)", factory: () => zaiProvider() },
    { id: "zai-coding-cn", name: "Z.AI Coding CN (GLM)", factory: () => zaiCodingCnProvider() },
    { id: "minimax", name: "MiniMax", factory: () => minimaxProvider() },
    { id: "minimax-cn", name: "MiniMax CN", factory: () => minimaxCnProvider() },
    { id: "openrouter", name: "OpenRouter", factory: () => openrouterProvider() },
];

/**
 * Registers ALL built-in providers into the catalog (pi-native: permanent).
 *
 * `setProvider` is upsert-by-id and idempotent — the facade may call it
 * once during construction (to resolve `defaultModel`) and again from
 * ModelRegistry's constructor without conflict. No provider is ever deleted.
 *
 * `extraModels` / `hiddenModels` (global config `providerExtraModels` /
 * `providerHiddenModels`) are the user's list edits, applied via
 * `withModelEdits`.
 */
export function applyBuiltinProviders(
    models: MutableModels,
    builtinProviders: ReadonlyArray<BuiltinProviderEntry> = BUILTIN_PROVIDER_FACTORIES,
    customProviders: readonly CustomProviderConfig[] = [],
    extraModels: Record<string, CustomModelEntry[]> = {},
    hiddenModels: Record<string, string[]> = {},
): void {
    for (const { factory } of builtinProviders) {
        models.setProvider(withModelEdits(factory(), extraModels, hiddenModels));
    }
    for (const cfg of customProviders) {
        models.setProvider(buildCustomProvider(cfg));
    }
}

/**
 * Convert a user-added entry into a chat Model for a built-in provider.
 * Conservative defaults mirror customProvider.toModel (reasoning/input cannot
 * be probed); `api`/`baseUrl` inherit from the provider's first static model
 * so the new model streams through the same protocol implementation.
 */
function toExtraModel(entry: CustomModelEntry, base: Provider): Model<Api> | undefined {
    const template = base.getModels()[0];
    if (!template) return undefined;
    return {
        id: entry.id,
        name: entry.name ?? entry.id,
        api: template.api,
        provider: base.id,
        baseUrl: template.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
        maxTokens: entry.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
    };
}

/**
 * Apply the user's model-list edits to a built-in provider: drop hidden
 * static ids, append user-added entries. pi's Provider is a plain object
 * whose getModels/getAllModels are own properties, so a spread wrapper
 * overrides them while stream dispatch keeps the base closures.
 *
 * Hiding filters the static list only — a user-added entry that happens to
 * share a hidden static id survives, since extras and removals are
 * independent edits.
 */
function withModelEdits(
    base: Provider,
    extraModels: Record<string, CustomModelEntry[]>,
    hiddenModels: Record<string, string[]>,
): Provider {
    const extras = (extraModels[base.id] ?? [])
        .map((e) => toExtraModel(e, base))
        .filter((m): m is Model<Api> => m !== undefined);
    const hidden = hiddenModels[base.id];
    if (extras.length === 0 && (!hidden || hidden.length === 0)) return base;
    const staticModels = (): Array<Model<Api>> =>
        hidden?.length
            ? (base.getModels() as Array<Model<Api>>).filter((m) => !hidden.includes(m.id))
            : (base.getModels() as Array<Model<Api>>);
    return {
        ...base,
        getModels: () => [...staticModels(), ...extras],
        // pi's Provider.getAllModels is optional; fall back to getModels.
        getAllModels: () => [
            ...((base.getAllModels?.() as Array<Model<Api>>) ?? base.getModels()).filter(
                (m) => !hidden?.length || !hidden.includes(m.id),
            ),
            ...extras,
        ],
    };
}

/** Looks up a model by id across providers. */
export function findModelById(models: MutableModels, id: string): Model<Api> | undefined {
    for (const m of models.getModels() as Array<Model<Api>>) {
        if (m.id === id) return m;
    }
    return undefined;
}

/** Maps a pi api string back to the taco protocol family (inverse of customProvider.toPiApi). */
function fromPiApi(api: Api): CustomProviderApi | undefined {
    switch (api) {
        case "openai-completions":
            return "chatcomplete";
        case "openai-responses":
            return "response";
        case "anthropic-messages":
            return "anthropic";
        default:
            return undefined;
    }
}

/**
 * Resolve a registered provider's `{ baseUrl, api }` for model discovery
 * (provider.listModels). Custom providers carry both on their config;
 * built-ins expose baseUrl on the Provider (falling back to the first static
 * model) and the protocol family is derived from the first static model's api.
 */
export function resolveProviderEndpoint(
    providerId: string,
    customProviders: readonly CustomProviderConfig[],
    builtinProviders: ReadonlyArray<BuiltinProviderEntry> = BUILTIN_PROVIDER_FACTORIES,
): { baseUrl: string; api: CustomProviderApi } | undefined {
    const custom = customProviders.find((c) => c.id === providerId);
    if (custom) return { baseUrl: custom.baseUrl, api: custom.api };
    const builtin = builtinProviders.find((b) => b.id === providerId);
    if (!builtin) return undefined;
    const provider = builtin.factory();
    const template = provider.getModels()[0];
    const baseUrl = provider.baseUrl ?? template?.baseUrl;
    const api = template ? fromPiApi(template.api) : undefined;
    if (!baseUrl || !api) return undefined;
    return { baseUrl, api };
}

/**
 * Build the pi Provider a session would stream through for `providerId`:
 * a custom provider from its config, or a built-in with the user's
 * extras/hides applied (same wrapper the catalog registers). Used by
 * provider.testConnection so a probe can target any model the picker offers.
 */
export function resolveProvider(
    providerId: string,
    customProviders: readonly CustomProviderConfig[],
    extraModels: Record<string, CustomModelEntry[]> = {},
    hiddenModels: Record<string, string[]> = {},
    builtinProviders: ReadonlyArray<BuiltinProviderEntry> = BUILTIN_PROVIDER_FACTORIES,
): Provider | undefined {
    const custom = customProviders.find((c) => c.id === providerId);
    if (custom) return buildCustomProvider(custom);
    const builtin = builtinProviders.find((b) => b.id === providerId);
    if (!builtin) return undefined;
    return withModelEdits(builtin.factory(), extraModels, hiddenModels);
}

export interface ModelRegistryOptions {
    readonly models: MutableModels;
    readonly sessionRegistry: SessionRegistry;
    /**
     * Process-level key store, used by `listConfiguredProviders` for the
     * availability check. Required — the constructor never reads
     * `process.env` directly so the test surface cannot be influenced by
     * ambient shell state. Production builds it unconditionally; tests pass
     * a fresh `ProviderKeyStore({})` (or seeded with the keys the case needs).
     */
    readonly providerKeyStore: ProviderKeyStore;
    /** Built-in providers — overrideable for tests; defaults to BUILTIN_PROVIDER_FACTORIES. */
    readonly builtinProviders?: ReadonlyArray<BuiltinProviderEntry>;
    /** Custom provider configs (injected into the catalog + shown in the availability view). */
    readonly customProviders?: readonly CustomProviderConfig[];
    /** User-added models for built-in providers (global config `providerExtraModels`). */
    readonly providerExtraModels?: Record<string, CustomModelEntry[]>;
    /** Static model ids hidden on built-in providers (global config `providerHiddenModels`). */
    readonly providerHiddenModels?: Record<string, string[]>;
    /**
     * When false, skip the constructor's built-in + custom provider registration.
     * Used by WorkspaceRuntime, which registers providers itself so the
     * defaultModel lookup can resolve before SessionRegistry is constructed.
     * `setProvider` is idempotent, so registering twice is harmless — but doing
     * the work exactly once avoids running the provider factories twice on
     * every workspace boot. Defaults to true.
     */
    readonly registerProviders?: boolean;
}

export class ModelRegistry {
    readonly models: MutableModels;
    private readonly sessionRegistry: SessionRegistry;
    private readonly providerKeyStore: ProviderKeyStore;
    private readonly builtinProviders: ReadonlyArray<BuiltinProviderEntry>;
    private customProviders: readonly CustomProviderConfig[];
    private extraModels: Record<string, CustomModelEntry[]>;
    private hiddenModels: Record<string, string[]>;

    constructor(options: ModelRegistryOptions) {
        this.models = options.models;
        this.sessionRegistry = options.sessionRegistry;
        this.providerKeyStore = options.providerKeyStore;
        this.builtinProviders = options.builtinProviders ?? BUILTIN_PROVIDER_FACTORIES;
        this.customProviders = options.customProviders ?? [];
        this.extraModels = options.providerExtraModels ?? {};
        this.hiddenModels = options.providerHiddenModels ?? {};

        // At startup: register all built-in + custom providers permanently. Built-ins
        // are never added or removed afterwards; runtime custom-provider changes
        // go through `setCustomProviders`.
        // WorkspaceRuntime pre-registers to unblock defaultModel lookup, so it
        // passes registerProviders:false to avoid running the factories twice.
        if (options.registerProviders !== false) {
            applyBuiltinProviders(
                this.models,
                this.builtinProviders,
                this.customProviders,
                this.extraModels,
                this.hiddenModels,
            );
        }
    }

    /**
     * Atomically swap the custom-provider set (after settings.write changes
     * `customProviders`). Delete old providers no longer in the new set,
     * upsert each provider in the new set. Only `custom:` ids are touched.
     *
     * NOT thread-safe. Callers must serialize `setCustomProviders` on the same
     * `ModelRegistry` — the `settings.write` handler is single-flight async/await.
     */
    setCustomProviders(next: readonly CustomProviderConfig[]): void {
        const nextIds = new Set(next.map((c) => c.id));
        for (const old of this.customProviders) {
            if (!nextIds.has(old.id)) this.models.deleteProvider(old.id);
        }
        for (const cfg of next) {
            this.models.setProvider(buildCustomProvider(cfg));
        }
        this.customProviders = next;
    }

    /**
     * Atomically swap the user's model-list edits for built-in providers (after
     * settings.write changes `providerExtraModels` / `providerHiddenModels`).
     * Re-registers every built-in with the wrapper applied — setProvider is
     * idempotent upsert, and already-resolved session Model objects are
     * unaffected. Both maps are re-applied together: a hide filters the static
     * list the same wrapper appends extras to, so swapping one alone would
     * silently drop the other's effect.
     */
    setProviderModelEdits(
        extras: Record<string, CustomModelEntry[]>,
        hidden: Record<string, string[]>,
    ): void {
        this.extraModels = extras;
        this.hiddenModels = hidden;
        for (const { factory } of this.builtinProviders) {
            this.models.setProvider(withModelEdits(factory(), extras, hidden));
        }
    }

    /** Lists every model in the catalog (across all permanent providers). */
    listAvailableModels(provider?: string): ModelInfo[] {
        const all = this.models.getModels(provider);
        return all.map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
    }

    /**
     * Availability view: each built-in provider with a `configured` flag and
     * its model list. For the UI's provider rows and "available models"
     * filter. Catalog is unchanged — this is computed purely on read.
     */
    listConfiguredProviders(): ProviderInfo[] {
        const builtins: ProviderInfo[] = this.builtinProviders.map(({ id, name, factory }) => {
            const extraIds = new Set((this.extraModels[id] ?? []).map((e) => e.id));
            const models: ModelInfo[] = this.listAvailableModels(id).map((m) => ({
                ...m,
                origin: extraIds.has(m.id) ? ("extra" as const) : ("builtin" as const),
            }));
            // One factory instance serves both reads below: the endpoint the
            // settings UI displays, and the static list the hidden ids filter.
            const built = factory();
            const template = built.getModels()[0];
            const api = template ? fromPiApi(template.api) : undefined;
            const baseUrl = built.baseUrl ?? template?.baseUrl;
            // Hidden statics are filtered out of the catalog, so read them off
            // the factory's own list — the settings UI offers them for restore.
            const hiddenIds = this.hiddenModels[id] ?? [];
            if (hiddenIds.length > 0) {
                const hiddenSet = new Set(hiddenIds);
                for (const m of built.getModels()) {
                    if (hiddenSet.has(m.id)) {
                        models.push({
                            provider: m.provider,
                            id: m.id,
                            name: m.name,
                            origin: "hidden" as const,
                        });
                    }
                }
            }
            return {
                id,
                name,
                configured: this.providerKeyStore.has(id),
                custom: false,
                baseUrl,
                api,
                models,
            };
        });
        const customs: ProviderInfo[] = this.customProviders.map((cfg) => ({
            id: cfg.id,
            name: cfg.name,
            configured: this.providerKeyStore.has(cfg.id),
            custom: true,
            baseUrl: cfg.baseUrl,
            api: cfg.api,
            models: this.listAvailableModels(cfg.id).map((m) => ({
                ...m,
                origin: "custom" as const,
            })),
        }));
        return [...builtins, ...customs];
    }

    /** Switches a session to {provider, modelId}. */
    async setSessionModel(sessionId: SessionId, provider: string, modelId: string): Promise<void> {
        const attached = this.sessionRegistry.getAttached(sessionId);
        if (!attached) {
            throw new Error(`session not attached: ${sessionId}`);
        }
        const newModel = this.models.getModel(provider, modelId);
        if (!newModel) {
            throw new Error(`unknown model: ${provider}/${modelId}`);
        }
        await attached.setModel(newModel);
    }

    /** Switches thinking level on an attached session at runtime. */
    async setSessionThinkingLevel(sessionId: SessionId, level: ThinkingLevel): Promise<void> {
        const attached = this.sessionRegistry.getAttached(sessionId);
        if (!attached) {
            throw new Error(`session not attached: ${sessionId}`);
        }
        await attached.setThinkingLevel(level);
    }
}
