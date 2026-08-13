/**
 * ModelRegistry — pi-native semantics: all providers are resident in the catalog
 * and do not change when keys are added or cleared. Availability is computed
 * lazily at read time via listConfiguredProviders (key-based); the catalog
 * itself stays stable.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/modelRegistry.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSessionId, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/compat";
import type { WorkspaceId } from "@taco-ai/protocol";
import { type BuiltinProviderEntry, ModelRegistry } from "../../src/runtime/modelRegistry.ts";
import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";
import { SessionRegistry } from "../../src/runtime/sessionRegistry.ts";

/**
 * Build a minimal stub Provider by hand. Real `createProvider` requires many
 * Model fields that aren't needed to test ModelRegistry's setProvider /
 * getModels flow. `as unknown as Provider` bypasses the full Provider type.
 */
function stubProvider(providerId: string, modelId: string): Provider {
    const model: Model<Api> = {
        id: modelId,
        name: modelId,
        api: "openai-responses",
        provider: providerId,
        baseUrl: "https://stub.example.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
    };
    return {
        id: providerId,
        name: providerId,
        auth: {
            apiKey: {
                name: `${providerId} test key`,
                resolve: async () => ({
                    auth: { apiKey: "stub-key-1234567890" },
                    source: "test-stub",
                }),
            },
        },
        getModels: () => [model],
        stream: () => {
            throw new Error("stub stream must not be called");
        },
        streamSimple: () => {
            throw new Error("stub streamSimple must not be called");
        },
    } as unknown as Provider;
}

let cwd: string;
let sessionsRoot: string;
let env: NodeExecutionEnv;
let repo: JsonlSessionRepo;
let models: ReturnType<typeof createModels>;

beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "taco-mr-cwd-"));
    sessionsRoot = mkdtempSync(join(tmpdir(), "taco-mr-sessions-"));
    env = new NodeExecutionEnv({ cwd });
    repo = new JsonlSessionRepo({ fs: env, sessionsRoot });
    models = createModels();
});

afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionsRoot, { recursive: true, force: true });
});

function makeSessionRegistry(): SessionRegistry {
    return new SessionRegistry({
        cwd: cwd as WorkspaceId,
        repo,
        sessionsRoot,
        env,
        models,
        systemPrompt: "test",
        tools: [],
        resources: {},
        streamOptions: {},
        spawnSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
        resumeSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
        spawnSkillSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
        availableAgentTypes: [],
        skills: [],
    });
}

const STUBS: BuiltinProviderEntry[] = [
    { id: "stub-a", name: "Stub A", factory: () => stubProvider("stub-a", "model-a") },
    { id: "stub-b", name: "Stub B", factory: () => stubProvider("stub-b", "model-b") },
];

describe("ModelRegistry — pi-native all-resident catalog", () => {
    it("registers ALL providers regardless of key presence", () => {
        // Only stub-a's key is configured, but both providers are resident in the catalog.
        const store = new ProviderKeyStore({ "stub-a": "key-a-1234567890" });
        new ModelRegistry({
            models,
            sessionRegistry: makeSessionRegistry(),
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        const providers = models.getModels().map((m) => m.provider);
        assert.ok(providers.includes("stub-a"), "stub-a resident");
        assert.ok(providers.includes("stub-b"), "stub-b resident even without key");
    });

    it("catalog does NOT change when a key is added or cleared", () => {
        const store = new ProviderKeyStore({});
        new ModelRegistry({
            models,
            sessionRegistry: makeSessionRegistry(),
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        const before = models
            .getModels()
            .map((m) => m.provider)
            .sort();
        assert.deepEqual(before, ["stub-a", "stub-b"]);

        // Adding / clearing keys does not touch the catalog (pi-native: key only affects lazy resolution at request time).
        store.update({ "stub-a": "key-a-1234567890" });
        assert.deepEqual(
            models
                .getModels()
                .map((m) => m.provider)
                .sort(),
            ["stub-a", "stub-b"],
        );
        store.update({ "stub-a": "" });
        assert.deepEqual(
            models
                .getModels()
                .map((m) => m.provider)
                .sort(),
            ["stub-a", "stub-b"],
        );
    });

    it("listConfiguredProviders marks configured by key presence", () => {
        const store = new ProviderKeyStore({ "stub-a": "key-a-1234567890" });
        const mr = new ModelRegistry({
            models,
            sessionRegistry: makeSessionRegistry(),
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        const list = mr.listConfiguredProviders();
        assert.equal(list.length, 2);
        const a = list.find((p) => p.id === "stub-a");
        const b = list.find((p) => p.id === "stub-b");
        assert.equal(a?.configured, true);
        assert.equal(a?.name, "Stub A");
        assert.equal(a?.models.length, 1);
        assert.equal(a?.models[0].id, "model-a");
        assert.equal(b?.configured, false, "stub-b has no key");
        assert.equal(b?.models.length, 1, "but its models are still listed");
    });

    it("listConfiguredProviders reflects a key added at runtime (no catalog change)", () => {
        const store = new ProviderKeyStore({});
        const mr = new ModelRegistry({
            models,
            sessionRegistry: makeSessionRegistry(),
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        assert.equal(
            mr.listConfiguredProviders().every((p) => !p.configured),
            true,
        );
        store.update({ "stub-b": "key-b-1234567890" });
        const b = mr.listConfiguredProviders().find((p) => p.id === "stub-b");
        assert.equal(b?.configured, true);
    });

    it("ProviderKeyStore.read serves keys by provider id (CredentialStore)", async () => {
        const store = new ProviderKeyStore({ "stub-a": "key-a-1234567890" });
        assert.deepEqual(await store.read("stub-a"), { type: "api_key", key: "key-a-1234567890" });
        assert.equal(await store.read("stub-b"), undefined);
        const listed = await store.list();
        assert.deepEqual(
            listed.map((c) => c.providerId),
            ["stub-a"],
        );
    });

    it("listAvailableModels returns all resident models; filters by provider", () => {
        const store = new ProviderKeyStore({});
        const mr = new ModelRegistry({
            models,
            sessionRegistry: makeSessionRegistry(),
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        assert.equal(mr.listAvailableModels().length, 2);
        const onlyA = mr.listAvailableModels("stub-a");
        assert.equal(onlyA.length, 1);
        assert.equal(onlyA[0].provider, "stub-a");
    });

    it("setSessionModel throws when session not attached", async () => {
        const store = new ProviderKeyStore({ "stub-a": "key-a-1234567890" });
        const mr = new ModelRegistry({
            models,
            sessionRegistry: makeSessionRegistry(),
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        const id = createSessionId();
        await assert.rejects(() => mr.setSessionModel(id, "stub-a", "model-a"), /not attached/);
    });

    it("setSessionModel throws on unknown model when session is attached", async () => {
        const store = new ProviderKeyStore({ "stub-a": "key-a-1234567890" });
        const defaultModel = stubProvider("stub-a", "model-a").getModels()[0];
        assert.ok(defaultModel, "stub should expose a model");
        const sr = new SessionRegistry({
            cwd: cwd as WorkspaceId,
            repo,
            sessionsRoot,
            env,
            models,
            defaultModel,
            systemPrompt: "test",
            tools: [],
            resources: {},
            streamOptions: {},
            spawnSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
            resumeSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
            spawnSkillSubagent: async () => ({ subSessionId: "", resultText: "", isError: true }),
            availableAgentTypes: [],
            skills: [],
        });
        const mr = new ModelRegistry({
            models,
            sessionRegistry: sr,
            providerKeyStore: store,
            builtinProviders: STUBS,
        });
        const sessionId = createSessionId();
        await repo.create({ id: sessionId, cwd });
        sr.invalidateListCache();
        await sr.attach(sessionId);
        try {
            await assert.rejects(
                () => mr.setSessionModel(sessionId, "stub-a", "nonexistent-model"),
                /unknown model/,
            );
        } finally {
            await sr.dispose();
        }
    });

    it("configured=false when providerKeyStore has no entry for the provider", () => {
        const mr = new ModelRegistry({
            providerKeyStore: new ProviderKeyStore({}),
            models,
            sessionRegistry: makeSessionRegistry(),
            builtinProviders: STUBS,
        });
        // catalog still fully resident
        assert.equal(mr.listAvailableModels().length, 2);
        // ProviderKeyStore is the sole source of truth — process.env no longer influences configured.
        const stubA = mr.listConfiguredProviders().find((p) => p.id === "stub-a");
        const stubB = mr.listConfiguredProviders().find((p) => p.id === "stub-b");
        assert.equal(stubA?.configured, false);
        assert.equal(stubB?.configured, false);
    });

    it("configured=true when providerKeyStore holds the entry for the provider", () => {
        const store = new ProviderKeyStore({ "stub-a": "key-a-1234567890" });
        const mr = new ModelRegistry({
            providerKeyStore: store,
            models,
            sessionRegistry: makeSessionRegistry(),
            builtinProviders: STUBS,
        });
        const stubA = mr.listConfiguredProviders().find((p) => p.id === "stub-a");
        const stubB = mr.listConfiguredProviders().find((p) => p.id === "stub-b");
        assert.equal(stubA?.configured, true);
        assert.equal(stubB?.configured, false);
    });

    describe("custom providers — setCustomProviders reconcile", () => {
        it("registers customs at construction; listed with custom:true", () => {
            const customs = [
                {
                    id: "custom:a",
                    name: "Custom A",
                    api: "chatcomplete" as const,
                    baseUrl: "https://a.example.com/v1",
                    models: [{ id: "m1" }, { id: "m2" }],
                },
            ];
            const store = new ProviderKeyStore({});
            const mr = new ModelRegistry({
                models,
                sessionRegistry: makeSessionRegistry(),
                providerKeyStore: store,
                builtinProviders: STUBS,
                customProviders: customs,
            });
            // catalog includes builtin + custom
            const providers = models.getModels().map((m) => m.provider);
            assert.ok(providers.includes("custom:a"));
            assert.ok(providers.includes("stub-a"));

            const list = mr.listConfiguredProviders();
            const a = list.find((p) => p.id === "custom:a");
            assert.equal(a?.custom, true);
            assert.equal(a?.models.length, 2);
            assert.equal(a?.configured, false);
        });

        it("setCustomProviders upserts new and deletes removed (idempotent)", () => {
            const initial = [
                {
                    id: "custom:a",
                    name: "A",
                    api: "chatcomplete" as const,
                    baseUrl: "https://a.example.com/v1",
                    models: [{ id: "m1" }],
                },
                {
                    id: "custom:b",
                    name: "B",
                    api: "response" as const,
                    baseUrl: "https://b.example.com/v1",
                    models: [{ id: "m1" }],
                },
            ];
            const store = new ProviderKeyStore({});
            const mr = new ModelRegistry({
                models,
                sessionRegistry: makeSessionRegistry(),
                providerKeyStore: store,
                builtinProviders: STUBS,
                customProviders: initial,
            });
            assert.ok(models.getModels().some((m) => m.provider === "custom:a"));
            assert.ok(models.getModels().some((m) => m.provider === "custom:b"));

            // Replace: b deleted, a retained, c added
            mr.setCustomProviders([
                {
                    id: "custom:a",
                    name: "A renamed",
                    api: "anthropic" as const,
                    baseUrl: "https://a.example.com/v2", // changed baseUrl
                    models: [{ id: "m1" }, { id: "m2" }],
                },
                {
                    id: "custom:c",
                    name: "C",
                    api: "chatcomplete" as const,
                    baseUrl: "https://c.example.com/v1",
                    models: [{ id: "m1" }],
                },
            ]);

            const providers = models.getModels().map((m) => m.provider);
            assert.ok(providers.includes("custom:a"), "a 仍在");
            assert.ok(providers.includes("custom:c"), "c 新增");
            assert.ok(!providers.includes("custom:b"), "b 已删");

            // a's catalog reflects the new baseUrl (changed provider field → Model.baseUrl)
            const aModels = mr.listAvailableModels("custom:a");
            assert.equal(aModels.length, 2);
            // b is gone entirely
            assert.equal(mr.listAvailableModels("custom:b").length, 0);
        });

        it("setCustomProviders replaces same id's models (upsert by id)", () => {
            // Real scenario: user edits a custom provider's models list, server saves, and
            // settings.write pushes the new full list — old model ids must be replaced by the new
            // list, not accumulated.
            const initial = [
                {
                    id: "custom:a",
                    name: "A",
                    api: "chatcomplete" as const,
                    baseUrl: "https://a.example.com/v1",
                    models: [{ id: "old-1" }, { id: "old-2" }, { id: "old-3" }],
                },
            ];
            const store = new ProviderKeyStore({});
            const mr = new ModelRegistry({
                models,
                sessionRegistry: makeSessionRegistry(),
                providerKeyStore: store,
                builtinProviders: STUBS,
                customProviders: initial,
            });
            assert.deepEqual(
                mr.listAvailableModels("custom:a").map((m) => m.id),
                ["old-1", "old-2", "old-3"],
            );

            // After editing: only one new model remains
            mr.setCustomProviders([
                {
                    id: "custom:a",
                    name: "A",
                    api: "chatcomplete" as const,
                    baseUrl: "https://a.example.com/v1",
                    models: [{ id: "new-1" }],
                },
            ]);

            assert.deepEqual(
                mr.listAvailableModels("custom:a").map((m) => m.id),
                ["new-1"],
                "old models must be replaced by the new list, not accumulated",
            );
        });

        it("setCustomProviders leaves builtin providers untouched", () => {
            const store = new ProviderKeyStore({ "stub-a": "k-1234567890" });
            const mr = new ModelRegistry({
                models,
                sessionRegistry: makeSessionRegistry(),
                providerKeyStore: store,
                builtinProviders: STUBS,
            });
            const beforeBuiltins = models
                .getModels()
                .filter((m) => !m.provider.startsWith("custom:"))
                .map((m) => m.provider)
                .sort();
            mr.setCustomProviders([
                {
                    id: "custom:z",
                    name: "Z",
                    api: "chatcomplete" as const,
                    baseUrl: "https://z.example.com/v1",
                    models: [{ id: "m1" }],
                },
            ]);
            const afterBuiltins = models
                .getModels()
                .filter((m) => !m.provider.startsWith("custom:"))
                .map((m) => m.provider)
                .sort();
            assert.deepEqual(afterBuiltins, beforeBuiltins, "builtins untouched");
            assert.ok(models.getModels().some((m) => m.provider === "custom:z"));
        });
    });
});
