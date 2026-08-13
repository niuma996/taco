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
import type { CustomProviderConfig, SessionId } from "@taco-ai/protocol";
import { buildCustomProvider } from "./customProvider.ts";
import type { ProviderKeyStore } from "./providerKeyStore.ts";
import type { SessionRegistry } from "./sessionRegistry.ts";

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
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
 */
export function applyBuiltinProviders(
    models: MutableModels,
    builtinProviders: ReadonlyArray<BuiltinProviderEntry> = BUILTIN_PROVIDER_FACTORIES,
    customProviders: readonly CustomProviderConfig[] = [],
): void {
    for (const { factory } of builtinProviders) {
        models.setProvider(factory());
    }
    for (const cfg of customProviders) {
        models.setProvider(buildCustomProvider(cfg));
    }
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

    constructor(options: ModelRegistryOptions) {
        this.models = options.models;
        this.sessionRegistry = options.sessionRegistry;
        this.providerKeyStore = options.providerKeyStore;
        this.builtinProviders = options.builtinProviders ?? BUILTIN_PROVIDER_FACTORIES;
        this.customProviders = options.customProviders ?? [];

        // At startup: register all built-in + custom providers permanently. Built-ins
        // are never added or removed afterwards; runtime custom-provider changes
        // go through `setCustomProviders`.
        // WorkspaceRuntime pre-registers to unblock defaultModel lookup, so it
        // passes registerProviders:false to avoid running the factories twice.
        if (options.registerProviders !== false) {
            applyBuiltinProviders(this.models, this.builtinProviders, this.customProviders);
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
        const builtins: ProviderInfo[] = this.builtinProviders.map(({ id, name }) => ({
            id,
            name,
            configured: this.providerKeyStore.has(id),
            custom: false,
            models: this.listAvailableModels(id),
        }));
        const customs: ProviderInfo[] = this.customProviders.map((cfg) => ({
            id: cfg.id,
            name: cfg.name,
            configured: this.providerKeyStore.has(cfg.id),
            custom: true,
            models: this.listAvailableModels(cfg.id),
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
