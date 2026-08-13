/**
 * ProviderKeyStore — covers update / has / subscribe / env injection.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/runtime/providerKeyStore.test.ts
 */

import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";

import { ProviderKeyStore } from "../../src/runtime/providerKeyStore.ts";

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
