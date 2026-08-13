/**
 * buildCustomProvider + validateCustomProviders — custom provider construction and validation.
 *
 * Maps 3 protocols (chatcomplete → openai-completions, response → openai-responses,
 * anthropic → anthropic-messages) to pi Provider shapes + ConfigModelEntry field
 * validation (id prefix, non-empty name/baseUrl/models, api in allowlist, dedup).
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/customProvider.test.ts
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateCustomProviders } from "../../src/config/config.ts";
import { buildCustomProvider } from "../../src/runtime/customProvider.ts";

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
});
