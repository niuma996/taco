/**
 * Custom provider construction — `CustomProviderConfig` → pi-ai `Provider`.
 *
 * Protocol mapping: "chatcomplete" → openai-completions,
 * "response" → openai-responses, "anthropic" → anthropic-messages.
 *
 * `cost` fields are all 0 — no visibility into third-party pricing.
 * `auth` uses `envApiKeyAuth` with an empty `envVars` list; the key is
 * supplied by the injected `ProviderKeyStore` keyed by `cfg.id`.
 */

import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { CustomModelEntry, CustomProviderApi, CustomProviderConfig } from "@taco-ai/protocol";

/** Default contextWindow for custom models. */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128_000;
/** Default maxTokens for custom models. */
export const DEFAULT_CUSTOM_MAX_TOKENS = 8_192;

/** Maps `CustomProviderApi` to the pi api string. */
function toPiApi(api: CustomProviderApi): Api {
    switch (api) {
        case "chatcomplete":
            return "openai-completions";
        case "response":
            return "openai-responses";
        case "anthropic":
            return "anthropic-messages";
    }
}

/** Maps `CustomProviderApi` to the pi `ProviderStreams` constructor. */
function toApiStreams(api: CustomProviderApi) {
    switch (api) {
        case "chatcomplete":
            return openAICompletionsApi();
        case "response":
            return openAIResponsesApi();
        case "anthropic":
            return anthropicMessagesApi();
    }
}

/** Maps `CustomModelEntry` to a pi-ai `Model`. `reasoning` / `input` cannot be probed — conservative values. */
export function toModel(entry: CustomModelEntry, cfg: CustomProviderConfig): Model<Api> {
    return {
        id: entry.id,
        name: entry.name ?? entry.id,
        api: toPiApi(cfg.api),
        provider: cfg.id,
        baseUrl: cfg.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: entry.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
        maxTokens: entry.maxTokens ?? DEFAULT_CUSTOM_MAX_TOKENS,
    };
}

/** Builds a custom `Provider`. */
export function buildCustomProvider(cfg: CustomProviderConfig): Provider {
    return createProvider({
        id: cfg.id,
        name: cfg.name,
        baseUrl: cfg.baseUrl,
        auth: { apiKey: envApiKeyAuth(`${cfg.name} API key`, []) },
        models: cfg.models.map((m) => toModel(m, cfg)),
        api: toApiStreams(cfg.api),
    });
}
