// Lite model resolution and fallback: only bounded auxiliary calls use it,
// and every failure path must degrade to the session's main model.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { asSessionId } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { MemoryExtractorImpl } from "../../src/memory/local/extractor.ts";
import {
    completeSimpleWithLiteFallback,
    LITE_BUDGET_CHARS,
    liteThinkingToRequest,
    resolveLiteModel,
    resolveLiteThinkingLevel,
} from "../../src/runtime/models/liteModel.ts";
import type {
    Api,
    ApiContext,
    AssistantMessage,
    Model,
    MutableModels,
} from "../../src/runtime/pi/types.ts";
import { normalizeContext } from "../../src/runtime/pi/values.ts";
import { TitleSummarizer } from "../../src/runtime/session/titleSummarizer.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("lite-model");

const LITE = { provider: "lite-provider", id: "lite-id" } as Model<Api>;
const MAIN = { provider: "main-provider", id: "main-id" } as Model<Api>;

type SimpleOptions = NonNullable<Parameters<MutableModels["completeSimple"]>[2]>;

/** A model with a declared context window; the resolver checks this value. */
function windowed(model: Model<Api>, contextWindow: number): Model<Api> {
    return { ...model, contextWindow, maxTokens: 8192 } as Model<Api>;
}

function assistantMessage(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
    } as unknown as AssistantMessage;
}

/** Minimal MutableModels stub exposing only what the two tested functions use. */
function fakeModels(opts: {
    getModel?: (provider: string, id: string) => Model<Api> | undefined;
    getModels?: () => readonly Model<Api>[];
    onCall: (model: Model<Api>, options: SimpleOptions) => Promise<AssistantMessage>;
}): MutableModels {
    return {
        getModel: opts.getModel ?? (() => undefined),
        getModels: opts.getModels ?? (() => []),
        completeSimple: async (model: Model<Api>, _context: ApiContext, options?: SimpleOptions) =>
            opts.onCall(model, options ?? {}),
    } as unknown as MutableModels;
}

function testContext(): ApiContext {
    return {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    } as unknown as ApiContext;
}

function noopOptions(): SimpleOptions {
    return {};
}

function resetLiteConfig(): void {
    saveGlobalConfig({ liteModel: null });
}

describe("resolveLiteModel", () => {
    it("returns undefined when liteModel is not configured", () => {
        resetLiteConfig();
        const models = fakeModels({
            getModel: () => windowed(LITE, 128_000),
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "title"), undefined);
    });

    it("resolves a provider/id config against the live catalog", () => {
        saveGlobalConfig({ liteModel: `${LITE.provider}/${LITE.id}` });
        const model = windowed(LITE, 128_000);
        const models = fakeModels({
            getModel: (provider, id) =>
                provider === LITE.provider && id === LITE.id ? model : undefined,
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "title"), model);
        assert.equal(readGlobalConfig().liteModel, `${LITE.provider}/${LITE.id}`);
    });

    it("resolves a bare id across providers", () => {
        saveGlobalConfig({ liteModel: LITE.id });
        const model = windowed(LITE, 128_000);
        const models = fakeModels({
            getModels: () => [model],
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "memory"), model);
    });

    it("returns undefined when the id cannot be resolved", () => {
        saveGlobalConfig({ liteModel: "missing-provider/missing-id" });
        const models = fakeModels({
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "title"), undefined);
    });

    it("skips a model whose window cannot hold the scenario budget", () => {
        saveGlobalConfig({ liteModel: `${LITE.provider}/${LITE.id}` });
        // One token ~= 4 chars; a 1000-token window is below even the title budget.
        const small = windowed(LITE, 1000);
        const models = fakeModels({
            getModel: () => small,
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "title"), undefined);
        assert.equal(resolveLiteModel(models, "memory"), undefined);
    });

    it("distinguishes scenarios by budget: a small window may fit title but not memory", () => {
        saveGlobalConfig({ liteModel: `${LITE.provider}/${LITE.id}` });
        // Enough chars for the title budget (+ overhead), not the memory budget.
        const chars = (LITE_BUDGET_CHARS.title + LITE_BUDGET_CHARS.memory) / 2 + 2000;
        const model = windowed(LITE, Math.ceil(chars / 4) + 1);
        const models = fakeModels({
            getModel: () => model,
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "title"), model);
        assert.equal(resolveLiteModel(models, "memory"), undefined);
    });

    it("reads config on every call so settings.write reaches attached sessions", () => {
        resetLiteConfig();
        const models = fakeModels({
            getModel: () => windowed(LITE, 128_000),
            onCall: async () => assistantMessage("unused"),
        });
        assert.equal(resolveLiteModel(models, "title"), undefined);
        saveGlobalConfig({ liteModel: `${LITE.provider}/${LITE.id}` });
        assert.ok(resolveLiteModel(models, "title"));
        saveGlobalConfig({ liteModel: null });
        assert.equal(resolveLiteModel(models, "title"), undefined);
    });
});

describe("auxiliary thinking requests", () => {
    // Exercise both production callers, including repeated calls on the same instance.
    for (const scenario of ["title", "memory"] as const) {
        function setup(
            lite: Model<Api> | undefined,
            main: Model<Api> = { ...MAIN, reasoning: true },
        ) {
            const seen: Array<{ id: string; reasoning: SimpleOptions["reasoning"] }> = [];
            let failLite = false;
            const models = fakeModels({
                onCall: async (model, options) => {
                    seen.push({ id: model.id, reasoning: options.reasoning });
                    if (failLite && model.id === LITE.id) throw new Error("lite offline");
                    return assistantMessage(scenario === "memory" ? "[]" : "A title");
                },
            });
            const caller =
                scenario === "title"
                    ? new TitleSummarizer(
                          models,
                          main,
                          asSessionId("test"),
                          async () => true,
                          () => lite,
                      )
                    : new MemoryExtractorImpl(
                          models,
                          main,
                          {
                              listTopics: () => [],
                              appendEntry: async () => {},
                              updateTopic: async () => {
                                  throw new Error("unexpected update");
                              },
                          },
                          "test-workspace",
                          () => lite,
                      );
            return {
                seen,
                failLite: () => {
                    failLite = true;
                },
                run: () =>
                    caller.onRunEnd([
                        {
                            role: "user",
                            content: "conversation ".repeat(40),
                            timestamp: Date.now(),
                        },
                    ]),
            };
        }

        it(`${scenario}: hot updates default, low, off and clear without recreating the caller`, async () => {
            const { run, seen } = setup({ ...windowed(LITE, 128_000), reasoning: true });
            for (const level of [null, "low", "off", null] as const) {
                saveGlobalConfig({ liteThinkingLevel: level });
                await run();
            }
            assert.deepEqual(
                seen.map((call) => call.reasoning),
                ["minimal", "low", undefined, "minimal"],
            );
        });

        it(`${scenario}: does not request reasoning from a non-reasoning lite model`, async () => {
            saveGlobalConfig({ liteThinkingLevel: "low" });
            const { run, seen } = setup({ ...windowed(LITE, 128_000), reasoning: false });
            await run();
            assert.deepEqual(seen, [{ id: LITE.id, reasoning: undefined }]);
        });

        it(`${scenario}: uses the lowest supported thinking level when off is unavailable`, async () => {
            saveGlobalConfig({ liteThinkingLevel: "off" });
            const { run, seen } = setup({
                ...windowed(LITE, 128_000),
                reasoning: true,
                thinkingLevelMap: { off: null, minimal: null },
            });
            await run();
            assert.deepEqual(seen, [{ id: LITE.id, reasoning: "low" }]);
        });

        it(`${scenario}: normalizes the default and explicit minimal to model capabilities`, async () => {
            const { run, seen } = setup({
                ...windowed(LITE, 128_000),
                reasoning: true,
                thinkingLevelMap: { minimal: null, low: null },
            });
            for (const level of [null, "minimal"] as const) {
                saveGlobalConfig({ liteThinkingLevel: level });
                await run();
            }
            assert.deepEqual(
                seen.map((call) => call.reasoning),
                ["medium", "medium"],
            );
        });

        it(`${scenario}: fallback derives the main model default instead of inheriting lite off`, async () => {
            saveGlobalConfig({ liteThinkingLevel: "off" });
            const { run, seen, failLite } = setup({ ...windowed(LITE, 128_000), reasoning: true });
            failLite();
            await run();
            assert.deepEqual(seen, [
                { id: LITE.id, reasoning: undefined },
                { id: MAIN.id, reasoning: "minimal" },
            ]);
        });

        it(`${scenario}: direct main calls normalize their own default`, async () => {
            saveGlobalConfig({ liteThinkingLevel: "off" });
            const { run, seen } = setup(undefined, {
                ...MAIN,
                reasoning: true,
                thinkingLevelMap: { minimal: null },
            });
            await run();
            assert.deepEqual(seen, [{ id: MAIN.id, reasoning: "low" }]);
        });
    }
});

describe("lite off provider payloads", () => {
    for (const api of ["anthropic-messages", "openai-responses"] as const) {
        for (const supportsOff of [true, false]) {
            it(`${api}: ${supportsOff ? "sends disabled thinking" : "uses supported thinking when off is unavailable"}`, async () => {
                saveGlobalConfig({ liteThinkingLevel: "off" });
                const model: Model<Api> = {
                    ...windowed(LITE, 128_000),
                    name: "Test lite model",
                    api,
                    baseUrl: "https://example.invalid/v1",
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    reasoning: true,
                    thinkingLevelMap: supportsOff ? {} : { off: null, minimal: null },
                    ...(api === "anthropic-messages"
                        ? { compat: { forceAdaptiveThinking: true } }
                        : {}),
                };
                const adapter =
                    api === "anthropic-messages" ? anthropicMessagesApi() : openAIResponsesApi();
                let payload: unknown;
                const models = fakeModels({
                    onCall: async (called, options) => {
                        const response = await adapter
                            .streamSimple(called, normalizeContext(testContext()), {
                                ...options,
                                apiKey: "test-api-key",
                                // The real adapter builds the payload, then stops before any network IO.
                                onPayload: (value) => {
                                    payload = value;
                                    throw new Error("payload captured");
                                },
                                fetch: async () => {
                                    throw new Error("unexpected network request");
                                },
                            })
                            .result();
                        assert.match(response.errorMessage ?? "", /payload captured/);
                        return assistantMessage("ok");
                    },
                });
                await completeSimpleWithLiteFallback(
                    models,
                    () => model,
                    MAIN,
                    testContext(),
                    (_model, thinking) => ({ reasoning: thinking?.reasoning }),
                );
                const request = payload as {
                    thinking?: { type: string };
                    output_config?: { effort: string };
                    reasoning?: { effort: string };
                };
                assert.ok(request, "the real provider adapter must build a request");
                if (api === "anthropic-messages") {
                    assert.equal(request.thinking?.type, supportsOff ? "disabled" : "adaptive");
                    if (!supportsOff) assert.equal(request.output_config?.effort, "low");
                } else {
                    assert.equal(request.reasoning?.effort, supportsOff ? "none" : "low");
                }
            });
        }
    }
});

describe("resolveLiteThinkingLevel", () => {
    it("returns undefined when unset", () => {
        saveGlobalConfig({ liteThinkingLevel: null });
        assert.equal(resolveLiteThinkingLevel(), undefined);
    });

    it("returns the configured level", () => {
        saveGlobalConfig({ liteThinkingLevel: "low" });
        assert.equal(resolveLiteThinkingLevel(), "low");
    });

    it("rejects an out-of-range value at write time, like thinkingLevel does", () => {
        saveGlobalConfig({ liteThinkingLevel: "low" });
        assert.throws(
            () => saveGlobalConfig({ liteThinkingLevel: "medium" as never }),
            /invalid liteThinkingLevel/,
        );
        // The rejected write leaves the previous value in place.
        assert.equal(resolveLiteThinkingLevel(), "low");
    });

    it("reads config on every call so settings.write reaches attached sessions", () => {
        saveGlobalConfig({ liteThinkingLevel: null });
        assert.equal(resolveLiteThinkingLevel(), undefined);
        saveGlobalConfig({ liteThinkingLevel: "minimal" });
        assert.equal(resolveLiteThinkingLevel(), "minimal");
        saveGlobalConfig({ liteThinkingLevel: null });
        assert.equal(resolveLiteThinkingLevel(), undefined);
    });
});

describe("liteThinkingToRequest", () => {
    it("maps off to no reasoning field", () => {
        assert.equal(liteThinkingToRequest("off"), undefined);
    });

    it("passes the other levels through", () => {
        assert.equal(liteThinkingToRequest("minimal"), "minimal");
        assert.equal(liteThinkingToRequest("low"), "low");
    });

    it("maps an unset level to no reasoning field", () => {
        assert.equal(liteThinkingToRequest(undefined), undefined);
    });
});

describe("completeSimpleWithLiteFallback", () => {
    /** Records the options each model was actually called with. */
    function trackingModels(behavior: (model: Model<Api>) => Promise<AssistantMessage>) {
        const seen: Array<{ id: string; options: SimpleOptions }> = [];
        const models = fakeModels({
            onCall: async (model, options) => {
                seen.push({ id: model.id, options });
                return behavior(model);
            },
        });
        return { models, seen };
    }

    it("uses the main model directly when no lite model is configured", async () => {
        const { models, seen } = trackingModels(async () => assistantMessage("main response"));
        const res = await completeSimpleWithLiteFallback(
            models,
            () => undefined,
            MAIN,
            testContext(),
            noopOptions,
        );
        assert.deepEqual(
            seen.map((s) => s.id),
            [MAIN.id],
        );
        assert.equal(res?.content[0]?.type, "text");
    });

    it("uses the lite model when it succeeds", async () => {
        const { models, seen } = trackingModels(async () => assistantMessage("lite title"));
        const res = await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            noopOptions,
        );
        assert.deepEqual(
            seen.map((s) => s.id),
            [LITE.id],
        );
        assert.equal((res?.content[0] as { text: string }).text, "lite title");
    });

    it("retries once on the main model when the lite call throws", async () => {
        const { models, seen } = trackingModels(async (m) => {
            if (m.id === LITE.id) throw new Error("lite offline");
            return assistantMessage("main response");
        });
        const res = await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            noopOptions,
        );
        assert.deepEqual(
            seen.map((s) => s.id),
            [LITE.id, MAIN.id],
        );
        assert.equal((res?.content[0] as { text: string }).text, "main response");
    });

    it("retries on the main model when the lite response has no text", async () => {
        const { models, seen } = trackingModels(async (m) =>
            m.id === LITE.id
                ? ({ content: [] } as unknown as AssistantMessage)
                : assistantMessage("main"),
        );
        const res = await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            noopOptions,
        );
        assert.deepEqual(
            seen.map((s) => s.id),
            [LITE.id, MAIN.id],
        );
        assert.ok(res);
    });

    for (const stopReason of ["error", "aborted"] as const) {
        it(`retries on the main model when partial text ends with ${stopReason}`, async () => {
            const { models, seen } = trackingModels(async (model) =>
                model.id === LITE.id
                    ? { ...assistantMessage("partial output"), stopReason }
                    : assistantMessage("main response"),
            );
            const res = await completeSimpleWithLiteFallback(
                models,
                () => windowed(LITE, 128_000),
                MAIN,
                testContext(),
                noopOptions,
            );
            assert.deepEqual(
                seen.map((call) => call.id),
                [LITE.id, MAIN.id],
            );
            assert.equal((res?.content[0] as { text: string }).text, "main response");
        });
    }

    it("skips lite when the full memory prompt exceeds its window", async () => {
        saveGlobalConfig({ liteModel: `${LITE.provider}/${LITE.id}` });
        const seen: string[] = [];
        const models = fakeModels({
            getModel: () => windowed(LITE, 8192),
            onCall: async (model) => {
                seen.push(model.id);
                return assistantMessage("[]");
            },
        });
        const topics = Array.from({ length: 40 }, (_, i) => ({
            id: `fact-${i}`,
            name: "Fact",
            description: "Prior fact",
            content: "x".repeat(1000),
            type: "project" as const,
            createdAt: new Date().toISOString(),
        }));
        const extractor = new MemoryExtractorImpl(
            models,
            MAIN,
            {
                listTopics: () => topics,
                appendEntry: async () => {},
                updateTopic: async () => topics[0],
            },
            "test-workspace",
            () => resolveLiteModel(models, "memory"),
        );
        await extractor.onRunEnd([
            { role: "user", content: "a".repeat(8000), timestamp: Date.now() },
        ]);
        assert.deepEqual(seen, [MAIN.id]);
    });

    it("reserves room for output and provider context overhead", async () => {
        const { models, seen } = trackingModels(async () => assistantMessage("main response"));
        await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 8192),
            MAIN,
            { ...testContext(), systemPrompt: "s".repeat(26_000) },
            noopOptions,
        );
        assert.deepEqual(
            seen.map((call) => call.id),
            [MAIN.id],
        );
    });

    it("returns undefined when both lite and main fail", async () => {
        const { models, seen } = trackingModels(async () => {
            throw new Error("down");
        });
        const res = await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            noopOptions,
        );
        assert.deepEqual(
            seen.map((s) => s.id),
            [LITE.id, MAIN.id],
        );
        assert.equal(res, undefined);
    });

    it("re-derives options for the model actually being called", async () => {
        const { models, seen } = trackingModels(async (m) => {
            if (m.id === LITE.id) throw new Error("lite offline");
            return assistantMessage("main");
        });
        await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            (m) => ({ temperature: m.id === LITE.id ? 0.1 : 0.7 }),
        );
        assert.deepEqual(
            seen.map((s) => ({ id: s.id, temperature: s.options.temperature })),
            [
                { id: LITE.id, temperature: 0.1 },
                { id: MAIN.id, temperature: 0.7 },
            ],
        );
    });

    it("passes the configured thinking level to the lite branch only", async () => {
        saveGlobalConfig({ liteThinkingLevel: "low" });
        const { models } = trackingModels(async (m) => {
            if (m.id === LITE.id) throw new Error("lite offline");
            return assistantMessage("main");
        });
        const overrides: Array<{ id: string; thinking: unknown }> = [];
        await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            (m, thinking) => {
                overrides.push({ id: m.id, thinking });
                return {};
            },
        );
        assert.deepEqual(overrides, [
            { id: LITE.id, thinking: { reasoning: "low" } },
            // The main-model fallback keeps the session's own default.
            { id: MAIN.id, thinking: undefined },
        ]);
    });

    it("keeps the model default when no thinking level is configured", async () => {
        saveGlobalConfig({ liteThinkingLevel: null });
        const { models } = trackingModels(async () => assistantMessage("ok"));
        const overrides: Array<unknown> = [];
        await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            (_m, thinking) => {
                overrides.push(thinking);
                return {};
            },
        );
        assert.deepEqual(overrides, [undefined]);
    });

    it("maps an explicit off to no reasoning field on the lite branch", async () => {
        saveGlobalConfig({ liteThinkingLevel: "off" });
        const { models } = trackingModels(async () => assistantMessage("ok"));
        const overrides: Array<unknown> = [];
        await completeSimpleWithLiteFallback(
            models,
            () => windowed(LITE, 128_000),
            MAIN,
            testContext(),
            (_m, thinking) => {
                overrides.push(thinking);
                return {};
            },
        );
        // Present wrapper with no reasoning: "off" is a choice, not "unset".
        assert.deepEqual(overrides, [{ reasoning: undefined }]);
    });
});
