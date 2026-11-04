// Lite model resolution and fallback: only bounded auxiliary calls use it,
// and every failure path must degrade to the session's main model.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readGlobalConfig, saveGlobalConfig } from "../../src/config/config.ts";
import { MemoryExtractorImpl } from "../../src/memory/local/extractor.ts";
import {
    completeSimpleWithLiteFallback,
    LITE_BUDGET_CHARS,
    resolveLiteModel,
} from "../../src/runtime/models/liteModel.ts";
import type {
    Api,
    ApiContext,
    AssistantMessage,
    Model,
    MutableModels,
} from "../../src/runtime/pi/types.ts";
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
});
