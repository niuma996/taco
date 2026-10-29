/**
 * Provider plumbing: custom-provider config, the key store, and the user-agent
 * header wrapper.
 */

import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { validateCustomProviders, validateProviderExtraModels } from "../../src/config/config.ts";
import { buildCustomProvider } from "../../src/runtime/models/customProvider.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { withTacoUserAgent } from "../../src/runtime/models/requestHeaders.ts";
import type { AgentHarnessStreamOptions, Models } from "../../src/runtime/pi/types.ts";
import { sidecarVersion } from "../../src/runtime/runtimeResources.ts";

describe("customProvider", () => {
    const VALID = {
        id: "custom:myrelay",
        name: "My Relay",
        api: "chatcomplete" as const,
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "llm-fast", name: "LLM Fast" }, { id: "llm-smart" }],
    };

    describe("buildCustomProvider", () => {
        it("maps chatcomplete → openai-completions api", () => {
            const p = buildCustomProvider(VALID);
            assert.equal(p.id, "custom:myrelay");
            assert.equal(p.name, "My Relay");
            // baseUrl forwarded
            assert.equal((p as { baseUrl?: string }).baseUrl, "https://api.example.com/v1");
            // Model mapping: api string + provider field + default name falls back to id
            const models = p.getModels();
            assert.equal(models.length, 2);
            const m0 = models[0] as unknown as {
                api: string;
                provider: string;
                id: string;
                name: string;
            };
            assert.equal(m0.api, "openai-completions");
            assert.equal(m0.provider, "custom:myrelay");
            assert.equal(m0.id, "llm-fast");
            assert.equal(m0.name, "LLM Fast");
            const m1 = models[1] as unknown as { id: string; name: string };
            assert.equal(m1.id, "llm-smart");
            assert.equal(m1.name, "llm-smart", "default name falls back to id");
        });

        it("maps response → openai-responses api", () => {
            const p = buildCustomProvider({ ...VALID, api: "response", id: "custom:resp" });
            const m = p.getModels()[0] as unknown as { api: string };
            assert.equal(m.api, "openai-responses");
        });

        it("maps anthropic → anthropic-messages api", () => {
            const p = buildCustomProvider({ ...VALID, api: "anthropic", id: "custom:ant" });
            const m = p.getModels()[0] as unknown as { api: string };
            assert.equal(m.api, "anthropic-messages");
        });

        it("a model is text-only unless the user declares images", () => {
            const p = buildCustomProvider({
                ...VALID,
                models: [{ id: "plain" }, { id: "eyes", input: ["text", "image"] }],
            });
            const [plain, eyes] = p.getModels();
            assert.deepEqual(plain?.input, ["text"]);
            assert.deepEqual(eyes?.input, ["text", "image"]);
        });

        it("keeps text even when the user declares only images", () => {
            const p = buildCustomProvider({ ...VALID, models: [{ id: "m", input: ["image"] }] });
            assert.deepEqual(p.getModels()[0]?.input, ["text", "image"]);
        });

        // The bug this guards: every added model was hardwired text-only, and
        // pi replaces image blocks with a placeholder for such a model, so a
        // vision model added by hand silently never saw an image.
        it("pi passes images through to a model declared as seeing them", () => {
            const p = buildCustomProvider({
                ...VALID,
                models: [{ id: "plain" }, { id: "eyes", input: ["text", "image"] }],
            });
            const [plain, eyes] = p.getModels();
            assert.ok(plain && eyes);
            const turn = [
                {
                    role: "user" as const,
                    content: [
                        { type: "text" as const, text: "what is this" },
                        { type: "image" as const, data: "AAAA", mimeType: "image/png" },
                    ],
                    timestamp: 0,
                },
            ];
            const kinds = (model: typeof plain) =>
                transformMessages(turn, model).flatMap((m) =>
                    Array.isArray(m.content) ? m.content.map((b) => b.type) : [],
                );
            assert.deepEqual(kinds(eyes), ["text", "image"]);
            assert.ok(!kinds(plain).includes("image"), "a text-only model has the image replaced");
        });

        it("emits a Credential-resolvable api key auth (envApiKeyAuth with no env fallback)", () => {
            const p = buildCustomProvider(VALID);
            // auth shape: ApiKeyAuth, resolve() reads no env when credential absent (envVars empty).
            // Only validates the shape — real credential resolution goes through pi's CredentialStore.
            const auth = p.auth as { apiKey?: { name?: string; resolve?: unknown } };
            assert.ok(auth.apiKey, "uses apiKey auth");
            assert.equal(typeof auth.apiKey?.resolve, "function");
            assert.equal(auth.apiKey?.name, "My Relay API key");
        });
    });

    describe("validateCustomProviders", () => {
        it("accepts a valid list and returns canonical entries", () => {
            const out = validateCustomProviders([VALID], "test");
            assert.ok(out);
            assert.equal(out?.length, 1);
            assert.equal(out?.[0].id, "custom:myrelay");
            assert.equal(out?.[0].models.length, 2);
        });

        it("returns undefined for undefined input (未设置字段)", () => {
            assert.equal(validateCustomProviders(undefined, "test"), undefined);
        });

        it("rejects non-array", () => {
            assert.throws(() => validateCustomProviders({ id: "x" }, "test"), /must be an array/);
        });

        it("rejects id without custom: prefix", () => {
            assert.throws(
                () => validateCustomProviders([{ ...VALID, id: "anthropic" }], "test"),
                /must start with "custom:"/,
            );
        });

        it("rejects duplicate ids within the array", () => {
            assert.throws(() => validateCustomProviders([VALID, VALID], "test"), /duplicate id/);
        });

        it("rejects empty / whitespace name", () => {
            assert.throws(
                () => validateCustomProviders([{ ...VALID, name: "   " }], "test"),
                /name must be a non-empty string/,
            );
        });

        it("rejects unknown api", () => {
            assert.throws(
                () =>
                    validateCustomProviders(
                        [{ ...VALID, api: "openai-responses" as unknown as "chatcomplete" }],
                        "test",
                    ),
                /api must be one of/,
            );
        });

        it("rejects empty baseUrl", () => {
            assert.throws(
                () => validateCustomProviders([{ ...VALID, baseUrl: "" }], "test"),
                /baseUrl must be a non-empty string/,
            );
        });

        it("rejects empty models array", () => {
            assert.throws(
                () => validateCustomProviders([{ ...VALID, models: [] }], "test"),
                /models must be a non-empty array/,
            );
        });

        it("rejects entry without string model id", () => {
            assert.throws(
                () =>
                    validateCustomProviders(
                        [
                            {
                                ...VALID,
                                models: [{ id: 42 as unknown as string }],
                            },
                        ],
                        "test",
                    ),
                /each model needs a string id/,
            );
        });

        it("rejects an input that is not a list of known kinds", () => {
            for (const input of ["image", ["text", "video"], [1], []]) {
                assert.throws(
                    () =>
                        validateCustomProviders(
                            [{ ...VALID, models: [{ id: "m", input: input as never }] }],
                            "test",
                        ),
                    /input of m must be a non-empty array/,
                );
                assert.throws(
                    () =>
                        validateProviderExtraModels(
                            { openai: [{ id: "m", input: input as never }] },
                            "test",
                        ),
                    /input of m must be a non-empty array/,
                );
            }
        });

        it("accepts a declared image input", () => {
            const out = validateCustomProviders(
                [{ ...VALID, models: [{ id: "m", input: ["text", "image"] }] }],
                "test",
            );
            assert.deepEqual(out?.[0]?.models[0]?.input, ["text", "image"]);
        });
    });
});

describe("providerKeyStore", () => {
    /**
     * Snapshot of `*_API_KEY` env vars so each test can run against a clean env
     * and restore afterwards. ProviderKeyStore mutates process.env directly
     * (syncToEnv), so without isolation a test leaking MINIMAX_API_KEY would
     * bleed into the next.
     */
    let envSnapshot: Record<string, string | undefined>;

    before(() => {
        envSnapshot = {};
        for (const k of Object.keys(process.env)) {
            if (k.endsWith("_API_KEY")) {
                envSnapshot[k] = process.env[k];
            }
        }
        // Clear all *_API_KEY entries before tests run.
        for (const k of Object.keys(envSnapshot)) {
            delete process.env[k];
        }
    });

    after(() => {
        // Restore original env.
        for (const [k, v] of Object.entries(envSnapshot)) {
            if (v === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = v;
            }
        }
    });

    afterEach(() => {
        // Clean between tests: drop any *_API_KEY that leaked in.
        for (const k of Object.keys(process.env)) {
            if (k.endsWith("_API_KEY")) {
                delete process.env[k];
            }
        }
    });

    describe("ProviderKeyStore", () => {
        it("has() returns false for unknown provider, true after update", () => {
            const store = new ProviderKeyStore();
            assert.equal(store.has("minimax"), false);
            store.update({ minimax: "sk-test-1234567890" });
            assert.equal(store.has("minimax"), true);
            assert.equal(store.get("minimax"), "sk-test-1234567890");
        });

        it("constructor seeds initial apiKeys and syncs to env", () => {
            const store = new ProviderKeyStore({ minimax: "sk-seed-key-1234567890" });
            assert.equal(store.has("minimax"), true);
            assert.equal(process.env.MINIMAX_API_KEY, "sk-seed-key-1234567890");
        });

        it("update shallow-merges: unmentioned keys are preserved", () => {
            const store = new ProviderKeyStore({
                minimax: "sk-minimax-1234567890",
                openai: "sk-openai-1234567890",
            });
            store.update({ anthropic: "sk-ant-1234567890" });
            assert.equal(store.has("minimax"), true);
            assert.equal(store.has("openai"), true);
            assert.equal(store.has("anthropic"), true);
        });

        it("update shallow-merge also preserves env vars for unmentioned providers", () => {
            // Shallow merge must hold on both store and env levels —
            // an update without minimax must not clear an existing MINIMAX_API_KEY.
            const store = new ProviderKeyStore({
                minimax: "sk-minimax-keep-1234567890",
                openai: "sk-openai-keep-1234567890",
            });
            assert.equal(process.env.MINIMAX_API_KEY, "sk-minimax-keep-1234567890");
            assert.equal(process.env.OPENAI_API_KEY, "sk-openai-keep-1234567890");
            store.update({ anthropic: "sk-ant-new-1234567890" });
            assert.equal(process.env.MINIMAX_API_KEY, "sk-minimax-keep-1234567890");
            assert.equal(process.env.OPENAI_API_KEY, "sk-openai-keep-1234567890");
            assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-new-1234567890");
        });

        it("update with empty string deletes the key (matches saveGlobalConfig semantics)", () => {
            const store = new ProviderKeyStore({ minimax: "sk-minimax-1234567890" });
            assert.equal(store.has("minimax"), true);
            store.update({ minimax: "" });
            assert.equal(store.has("minimax"), false);
            assert.equal(store.get("minimax"), undefined);
            // env var must also be cleared
            assert.equal(process.env.MINIMAX_API_KEY, undefined);
        });

        it("update with undefined value deletes the key", () => {
            const store = new ProviderKeyStore({ minimax: "sk-minimax-1234567890" });
            store.update({ minimax: undefined });
            assert.equal(store.has("minimax"), false);
            assert.equal(process.env.MINIMAX_API_KEY, undefined);
        });

        it("update writes corresponding *_API_KEY env var for built-in providers", () => {
            const store = new ProviderKeyStore();
            store.update({
                anthropic: "sk-ant-test-1234567890",
                openai: "sk-openai-test-1234567890",
                "minimax-cn": "sk-cp-test-1234567890",
            });
            assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-test-1234567890");
            assert.equal(process.env.OPENAI_API_KEY, "sk-openai-test-1234567890");
            // "minimax-cn" → MINIMAX_CN_API_KEY (dash → underscore, uppercased)
            assert.equal(process.env.MINIMAX_CN_API_KEY, "sk-cp-test-1234567890");
        });

        it("update clears stale env var when key is removed", () => {
            const store = new ProviderKeyStore({ minimax: "sk-minimax-1234567890" });
            assert.equal(process.env.MINIMAX_API_KEY, "sk-minimax-1234567890");
            store.update({ minimax: "" });
            assert.equal(process.env.MINIMAX_API_KEY, undefined);
        });

        // ── pi CredentialStore contract ──

        it("read returns api_key credential by provider id", async () => {
            const store = new ProviderKeyStore({ anthropic: "sk-ant-1234567890" });
            assert.deepEqual(await store.read("anthropic"), {
                type: "api_key",
                key: "sk-ant-1234567890",
            });
            assert.equal(await store.read("openai"), undefined);
        });

        it("read reflects update (add + clear)", async () => {
            const store = new ProviderKeyStore();
            assert.equal(await store.read("minimax"), undefined);
            store.update({ minimax: "sk-minimax-1234567890" });
            assert.deepEqual(await store.read("minimax"), {
                type: "api_key",
                key: "sk-minimax-1234567890",
            });
            store.update({ minimax: "" });
            assert.equal(await store.read("minimax"), undefined);
        });

        it("list returns only configured provider ids, no secrets", async () => {
            const store = new ProviderKeyStore({
                anthropic: "sk-ant-1234567890",
                openai: "",
            });
            const listed = await store.list();
            assert.deepEqual(
                listed.map((c) => c.providerId),
                ["anthropic"],
            );
            assert.equal(listed[0].type, "api_key");
        });

        it("modify writes a new key and read sees it", async () => {
            const store = new ProviderKeyStore();
            const result = await store.modify("deepseek", async () => ({
                type: "api_key",
                key: "sk-deepseek-1234567890",
            }));
            assert.deepEqual(result, { type: "api_key", key: "sk-deepseek-1234567890" });
            assert.deepEqual(await store.read("deepseek"), {
                type: "api_key",
                key: "sk-deepseek-1234567890",
            });
        });

        it("modify with undefined leaves the entry unchanged", async () => {
            const store = new ProviderKeyStore({ deepseek: "sk-deepseek-1234567890" });
            await store.modify("deepseek", async () => undefined);
            assert.deepEqual(await store.read("deepseek"), {
                type: "api_key",
                key: "sk-deepseek-1234567890",
            });
        });

        it("delete removes the credential", async () => {
            const store = new ProviderKeyStore({ minimax: "sk-minimax-1234567890" });
            await store.delete("minimax");
            assert.equal(await store.read("minimax"), undefined);
            assert.equal(store.has("minimax"), false);
        });

        describe("syncToEnv — sentinel for self-injected keys", () => {
            it("does NOT clear externally-injected *_API_KEY on construction", () => {
                // Keys injected by shell before sidecar starts must not be clobbered.
                process.env.GOOGLE_API_KEY = "shell-injected-google-1234567890";
                process.env.XAI_API_KEY = "shell-injected-xai-1234567890";

                // Construction with empty apiKeys triggers syncToEnv.
                const store = new ProviderKeyStore();
                // Read credential to confirm it goes through CredentialStore path (no env effect).
                assert.equal(store.has("google"), false);
                assert.equal(store.has("xai"), false);

                assert.equal(
                    process.env.GOOGLE_API_KEY,
                    "shell-injected-google-1234567890",
                    "shell-injected GOOGLE_API_KEY must be preserved",
                );
                assert.equal(
                    process.env.XAI_API_KEY,
                    "shell-injected-xai-1234567890",
                    "shell-injected XAI_API_KEY must be preserved",
                );
            });

            it("clears only its own injected env keys on update", () => {
                process.env.SHELL_KEY = "shell-injected-1234567890";
                const store = new ProviderKeyStore({ deepseek: "sk-deepseek-1234567890" });
                // Construction injected DEEPSEEK_API_KEY (tracked by sentinel)
                assert.equal(process.env.DEEPSEEK_API_KEY, "sk-deepseek-1234567890");

                // update clears deepseek; env clear must only delete DEEPSEEK_API_KEY (self-injected),
                // not SHELL_KEY (external).
                store.update({ deepseek: "" });
                assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
                assert.equal(
                    process.env.SHELL_KEY,
                    "shell-injected-1234567890",
                    "externally shell-injected key must be preserved",
                );
            });
        });
    });
});

describe("requestHeaders.userAgent", () => {
    /** Only `checkAuth` is exercised; the rest of Models is irrelevant here. */
    const stubModels = (checkAuth: Models["checkAuth"]): Models =>
        ({ checkAuth }) as unknown as Models;

    const apiKeyModels = stubModels(async () => ({ source: "ANTHROPIC_API_KEY", type: "api_key" }));
    const oauthModels = stubModels(async () => ({ source: "OAuth", type: "oauth" }));
    const unknownModels = stubModels(async () => undefined);
    const failingModels = stubModels(async () => {
        throw new Error("credential store read failed");
    });

    describe("withTacoUserAgent", () => {
        it("tags api-key providers with taco/<version> + version header", async () => {
            const out = await withTacoUserAgent({}, apiKeyModels, "anthropic");
            const version = sidecarVersion();
            assert.equal(out.headers?.["user-agent"], `taco/${version}`);
            assert.equal(out.headers?.["x-taco-sidecar-version"], version);
        });

        it("leaves OAuth providers' user-agent alone but still tags the version", async () => {
            // `user-agent` must stay `claude-cli/<version>` for Anthropic OAuth
            // beta features. `x-taco-sidecar-version` is metadata only, so it
            // can ride alongside.
            const out = await withTacoUserAgent({}, oauthModels, "anthropic");
            const version = sidecarVersion();
            assert.equal(out.headers?.["user-agent"], undefined);
            assert.equal(out.headers?.["x-taco-sidecar-version"], version);
        });

        it("tags providers checkAuth cannot classify", async () => {
            const out = await withTacoUserAgent({}, unknownModels, "custom");
            assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
            assert.equal(out.headers?.["x-taco-sidecar-version"], sidecarVersion());
        });

        it("drops the user-agent override on credential-store failure but keeps the version header", async () => {
            // We can't know if the provider behind a failing credential store
            // is OAuth, so the UA override is unsafe. The version header is
            // safe metadata and stays.
            const out = await withTacoUserAgent({}, failingModels, "anthropic");
            const version = sidecarVersion();
            assert.equal(out.headers?.["user-agent"], undefined);
            assert.equal(out.headers?.["x-taco-sidecar-version"], version);
        });

        it("preserves caller headers and other stream options", async () => {
            const base: AgentHarnessStreamOptions = {
                headers: { "x-custom": "keep" },
                timeoutMs: 1234,
            };
            const out = await withTacoUserAgent(base, apiKeyModels, "anthropic");
            assert.equal(out.headers?.["x-custom"], "keep");
            assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
            assert.equal(out.timeoutMs, 1234);
            // MUST not mutate the caller's options
            assert.equal(base.headers?.["user-agent"], undefined);
        });

        it("lets a caller-supplied user-agent lose to the taco tag", async () => {
            const out = await withTacoUserAgent(
                { headers: { "user-agent": "caller/1.0" } },
                apiKeyModels,
                "anthropic",
            );
            assert.equal(out.headers?.["user-agent"], `taco/${sidecarVersion()}`);
        });

        it("drops a caller-supplied user-agent on OAuth paths so claude-cli survives", async () => {
            // Regression: the OAuth branch must not just OMIT its own UA tag
            // — it must actively strip a UA the caller placed in
            // streamOptions.headers, otherwise pi-ai's `claude-cli/<version>`
            // gets overridden and Claude Code's OAuth beta features break.
            const out = await withTacoUserAgent(
                { headers: { "user-agent": "caller/1.0", "x-custom": "keep" } },
                oauthModels,
                "anthropic",
            );
            assert.equal(out.headers?.["user-agent"], undefined);
            // The version header still rides; the caller's non-UA headers
            // (x-custom) are untouched.
            assert.equal(out.headers?.["x-taco-sidecar-version"], sidecarVersion());
            assert.equal(out.headers?.["x-custom"], "keep");
        });

        it("drops a caller-supplied user-agent on credential-store failure too", async () => {
            // Same reason as OAuth: we don't know if the failing provider is
            // OAuth, so any caller-supplied UA is unsafe to forward.
            const out = await withTacoUserAgent(
                { headers: { "user-agent": "caller/1.0" } },
                failingModels,
                "anthropic",
            );
            assert.equal(out.headers?.["user-agent"], undefined);
            assert.equal(out.headers?.["x-taco-sidecar-version"], sidecarVersion());
        });
    });
});
