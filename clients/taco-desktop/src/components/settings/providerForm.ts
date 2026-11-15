import type {
    CustomModelEntry,
    CustomProviderApi,
    CustomProviderConfig,
    ProviderView,
} from "@taco-ai/protocol";
import { CUSTOM_PROVIDER_PREFIX } from "@taco-ai/protocol";
import { parseModelWindow } from "../../lib/modelWindow.ts";

export const WINDOW_PRESETS = [32_000, 128_000, 200_000, 256_000, 512_000, 1_000_000] as const;
export const WINDOW_DEFAULT = "default";
export const WINDOW_CUSTOM = "custom";

export interface ProviderModelDraft extends CustomModelEntry {
    images: "unchanged" | "on" | "off";
    windowDraft: string;
    windowMode: string;
}

export interface ProviderFormDraft {
    id: string;
    name: string;
    api: CustomProviderApi;
    baseUrl: string;
    keyInput: string;
    models: ProviderModelDraft[];
    hidden: string[];
    manualId: string;
}

export function modelDraft(model: CustomModelEntry): ProviderModelDraft {
    return {
        ...model,
        images: "unchanged",
        windowDraft: model.contextWindow?.toString() ?? "",
        windowMode:
            model.contextWindow === undefined
                ? WINDOW_DEFAULT
                : WINDOW_PRESETS.some((preset) => preset === model.contextWindow)
                  ? String(model.contextWindow)
                  : WINDOW_CUSTOM,
    };
}

export function modelPayload({
    images,
    windowDraft,
    windowMode: _mode,
    ...model
}: ProviderModelDraft): CustomModelEntry {
    const contextWindow = parseModelWindow(windowDraft);
    // Keep existing property positions: ProviderSection compares serialized extras.
    const result = { ...model };
    if (contextWindow === undefined) delete result.contextWindow;
    else result.contextWindow = contextWindow;
    if (images === "unchanged") return result;
    const { input: _input, ...rest } = result;
    return images === "on" ? { ...rest, input: ["text", "image"] } : rest;
}

export function providerDefaults(
    provider?: ProviderView,
    cfg?: CustomProviderConfig,
): ProviderFormDraft {
    const custom = provider === undefined || provider.custom;
    const models = custom
        ? (cfg?.models ?? [])
        : provider.models
              .filter((model) => model.origin === "extra")
              .map(
                  (model): CustomModelEntry => ({
                      id: model.id,
                      // The catalog substitutes the id for an undeclared display name.
                      ...(model.name !== undefined && model.name !== model.id
                          ? { name: model.name }
                          : {}),
                      ...(model.contextWindow === undefined
                          ? {}
                          : { contextWindow: model.contextWindow }),
                      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
                      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
                      ...(model.input === undefined ? {} : { input: model.input }),
                  }),
              );
    return {
        id: cfg?.id ?? `${CUSTOM_PROVIDER_PREFIX}${crypto.randomUUID().slice(0, 8)}`,
        name: cfg?.name ?? "",
        api: cfg?.api ?? "chatcomplete",
        baseUrl: cfg?.baseUrl ?? "",
        keyInput: "",
        models: models.map(modelDraft),
        hidden: custom
            ? []
            : provider.models.filter((model) => model.origin === "hidden").map((model) => model.id),
        manualId: "",
    };
}
