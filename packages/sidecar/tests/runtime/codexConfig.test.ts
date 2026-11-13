import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import {
    codexAuthState,
    codexHome,
    readCodexUserConfig,
} from "../../src/runtime/subagent/codex/codexConfig.ts";
import { getCodexRuntimeStatus } from "../../src/runtime/subagent/codex/codexRuntimeInstall.ts";
import type { CodexSdkModule, LoadedCodexSdk } from "../../src/runtime/subagent/codex/codexSdk.ts";

describe("Codex user configuration", () => {
    let home: string;

    before(async () => {
        home = await mkdtemp(join(tmpdir(), "codex-config-"));
    });

    after(async () => {
        await rm(home, { recursive: true, force: true });
    });

    it("reads the model and provider from config.toml", async () => {
        await writeFile(
            join(home, "config.toml"),
            ['model = "MiniMax-M3"', 'model_provider = "custom"', ""].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.model, "MiniMax-M3");
        assert.equal(config.provider, "custom");
    });

    it("treats a provider that carries its own credentials as usable", async () => {
        await writeFile(
            join(home, "config.toml"),
            [
                'model_provider = "custom"',
                "",
                "[model_providers.custom]",
                'name = "custom"',
                'base_url = "http://127.0.0.1:15721/v1"',
                "requires_openai_auth = false",
                "",
            ].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.requiresOpenAiAuth, false);
        assert.equal(codexAuthState(config), "signed-in");
    });

    it("treats a quoted third-party provider without an auth flag as self-authenticated", async () => {
        await writeFile(
            join(home, "config.toml"),
            [
                'model_provider = "my-provider"',
                "",
                '[model_providers."my-provider"]',
                'name = "my-provider"',
                'base_url = "https://relay.example/v1/#models"',
                "",
            ].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.requiresOpenAiAuth, false);
        assert.equal(codexAuthState(config), "signed-in");
    });

    it("reports unknown auth when the configured provider has no provider entry", async () => {
        await writeFile(
            join(home, "config.toml"),
            ['model_provider = "missing-provider"', ""].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.requiresOpenAiAuth, undefined);
        assert.equal(codexAuthState(config), "unknown");
    });

    it("does not treat a differently cased provider ID as built-in OpenAI", async () => {
        await writeFile(join(home, "config.toml"), 'model_provider = "OpenAI"\n');
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(codexAuthState(config), "unknown");
    });

    it("uses third-party defaults for a defined provider named OpenAI", async () => {
        await writeFile(
            join(home, "config.toml"),
            'model_provider = "OpenAI"\n[model_providers.OpenAI]\nname = "Relay"\n',
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.requiresOpenAiAuth, false);
        assert.equal(codexAuthState(config), "signed-in");
    });

    for (const text of [
        "model = 123",
        "model_provider = 123",
        "model_providers = 123",
        'model_provider = "relay"\nmodel_providers.relay = 123',
        'model_provider = "relay"\n[[model_providers.relay]]\nname = "Relay"',
    ]) {
        it(`keeps auth unknown for invalid field types ${JSON.stringify(text)}`, async () => {
            await writeFile(join(home, "config.toml"), text);
            const config = readCodexUserConfig({ CODEX_HOME: home });
            assert.equal(codexAuthState(config), "unknown");
        });
    }

    it("preserves hashes and escapes in model and quoted provider names", async () => {
        await writeFile(
            join(home, "config.toml"),
            [
                'model = "model\\u002d#1" # trailing comment',
                'model_provider = "relay#1"',
                '[model_providers."relay#1"]',
                'name = "relay#1"',
                "requires_openai_auth = false",
            ].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.model, "model-#1");
        assert.equal(config.provider, "relay#1");
        assert.equal(codexAuthState(config), "signed-in");
    });

    it("honors an explicit OpenAI auth requirement for a third-party provider", async () => {
        await writeFile(
            join(home, "config.toml"),
            'model_provider = "relay"\n[model_providers.relay]\nrequires_openai_auth = true\n',
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.requiresOpenAiAuth, true);
        assert.equal(codexAuthState(config), "signed-out");
    });

    for (const flag of ['"false"', "123"]) {
        it(`keeps auth unknown for an invalid auth flag ${flag}`, async () => {
            await writeFile(
                join(home, "config.toml"),
                `model_provider = "relay"\n[model_providers.relay]\nrequires_openai_auth = ${flag}\n`,
            );
            const config = readCodexUserConfig({ CODEX_HOME: home });
            assert.equal(config.requiresOpenAiAuth, undefined);
            assert.equal(codexAuthState(config), "unknown");
        });
    }

    for (const text of ['model = "unfinished', 'model = "a"\nmodel = "b"']) {
        it(`keeps auth unknown for invalid TOML ${JSON.stringify(text)}`, async () => {
            await writeFile(join(home, "config.toml"), text);
            const config = readCodexUserConfig({ CODEX_HOME: home, OPENAI_API_KEY: "sk-test" });
            assert.equal(config.requiresOpenAiAuth, undefined);
            assert.equal(codexAuthState(config), "unknown");
        });
    }

    it("requires an OpenAI login when the provider asks for one", async () => {
        await writeFile(
            join(home, "config.toml"),
            [
                'model_provider = "openai"',
                "",
                "[model_providers.openai]",
                'name = "OpenAI"',
                "",
            ].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home });
        assert.equal(config.requiresOpenAiAuth, true);
        assert.equal(codexAuthState(config), "signed-out");
    });

    it("accepts an API key as OpenAI credentials", async () => {
        await writeFile(
            join(home, "config.toml"),
            [
                'model_provider = "openai"',
                "",
                "[model_providers.openai]",
                'name = "OpenAI"',
                "",
            ].join("\n"),
        );
        const config = readCodexUserConfig({ CODEX_HOME: home, OPENAI_API_KEY: "sk-test" });
        assert.equal(codexAuthState(config), "signed-in");
    });

    it("cannot tell when there is no config.toml at all", () => {
        const config = readCodexUserConfig({ CODEX_HOME: join(home, "absent") });
        assert.equal(config.readable, false);
        assert.equal(codexAuthState(config), "unknown");
    });

    it("uses $CODEX_HOME when it is set and the platform home otherwise", () => {
        assert.equal(codexHome({ CODEX_HOME: "/tmp/elsewhere" }), "/tmp/elsewhere");
        const platformHome =
            process.platform === "win32" ? { USERPROFILE: "/tmp/home" } : { HOME: "/tmp/home" };
        assert.equal(codexHome(platformHome), join("/tmp/home", ".codex"));
    });

    for (const injected of [true, false]) {
        it(`${injected ? "ignores a Taco-injected" : "accepts a shell-supplied"} OpenAI key in runtime status`, async () => {
            const originalHome = process.env.CODEX_HOME;
            const originalOpenAiKey = process.env.OPENAI_API_KEY;
            const store = injected ? new ProviderKeyStore({ openai: "sk-taco-only" }) : undefined;
            if (!injected) process.env.OPENAI_API_KEY = "sk-shell-test";
            await writeFile(
                join(home, "config.toml"),
                ['model_provider = "openai"', "", "[model_providers.openai]", ""].join("\n"),
            );
            process.env.CODEX_HOME = home;
            try {
                const loaded: LoadedCodexSdk = {
                    module: {} as CodexSdkModule,
                    version: "0.167.2",
                    packageRoot: home,
                    entryPath: join(home, "index.js"),
                };
                const status = await getCodexRuntimeStatus({
                    loadSdk: async () => loaded,
                    createClient: () => ({
                        startThread: () => assert.fail(),
                        resumeThread: () => assert.fail(),
                    }),
                    resolveCliEntry: () => undefined,
                });
                assert.equal(status.auth, injected ? "signed-out" : "signed-in");
            } finally {
                store?.update({ openai: "" });
                if (originalHome === undefined) delete process.env.CODEX_HOME;
                else process.env.CODEX_HOME = originalHome;
                if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
                else process.env.OPENAI_API_KEY = originalOpenAiKey;
            }
        });
    }
});
