import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import { maskKey, toView } from "../../../src/server/handlers/settings.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { SidecarServer } from "../../../src/server/server.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

const CUSTOM_A = {
    id: "custom:relay-a",
    name: "Relay A",
    api: "chatcomplete" as const,
    baseUrl: "https://relay-a.example.com/v1",
    models: [{ id: "m1" }, { id: "m2" }],
};
const CUSTOM_B = {
    ...CUSTOM_A,
    id: "custom:relay-b",
    name: "Relay B",
    models: [{ id: "other-model" }],
};

describe("settings.write on a real server", () => {
    const home = useTempTacoHome("settings-runtime");
    let server: SidecarServer;

    beforeEach(() => {
        writeFileSync(join(home, "taco.json"), "{}");
        server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    });
    afterEach(async () => {
        await server.stop();
    });

    const write = (global: unknown) =>
        callMethod<{ global: unknown }>("settings.write", {
            server,
            params: { global },
        });
    const workspace = () =>
        server.ensureWorkspace(asWorkspaceId(mkdtempSync(join(home, "workspace-"))));

    it("updates keys and returns a masked view after refreshing the runtime", async (t) => {
        const broadcasts = t.mock.method(server, "broadcastModelsChanged");
        const key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
        const result = await write({ apiKeys: { anthropic: key } });
        assert.equal(server.providerKeyStore.get("anthropic"), key);
        assert.equal(readGlobalConfig().apiKeys?.anthropic, key);
        assert.deepEqual(result.global, toView(readGlobalConfig()));
        assert.ok(!JSON.stringify(result).includes(key));
        assert.equal(broadcasts.mock.callCount(), 1);
    });

    it("persists and reconciles custom providers in an existing and a future workspace", async () => {
        const existing = await workspace();
        await write({ customProviders: [CUSTOM_A] });
        assert.deepEqual(readGlobalConfig().customProviders, [CUSTOM_A]);
        assert.equal(existing.models.getModel(CUSTOM_A.id, "m1")?.id, "m1");
        assert.deepEqual(server.getProviderEndpoint(CUSTOM_A.id), {
            baseUrl: CUSTOM_A.baseUrl,
            api: CUSTOM_A.api,
        });
        const future = await workspace();
        assert.equal(future.models.getModel(CUSTOM_A.id, "m2")?.id, "m2");
        await write({ customProviders: [CUSTOM_B] });
        for (const ws of [existing, future]) {
            assert.equal(ws.models.getModel(CUSTOM_A.id, "m1"), undefined);
            assert.equal(ws.models.getModel(CUSTOM_B.id, "other-model")?.id, "other-model");
        }
        await write({ customProviders: [] });
        assert.deepEqual(readGlobalConfig().customProviders, []);
        assert.equal(server.buildProvider(CUSTOM_B.id), undefined);
        assert.equal(existing.models.getModel(CUSTOM_B.id, "other-model"), undefined);
    });

    it("announces custom-provider changes once and ignores identical writes", async (t) => {
        const broadcasts = t.mock.method(server, "broadcastModelsChanged");
        await write({ customProviders: [CUSTOM_A] });
        assert.equal(broadcasts.mock.callCount(), 1);
        await write({ customProviders: [CUSTOM_A] });
        assert.equal(broadcasts.mock.callCount(), 1);
        await write({ customProviders: [] });
        assert.equal(broadcasts.mock.callCount(), 2);
    });

    it("leaves catalogs and compaction caches untouched for an unrelated patch", async (t) => {
        const custom = t.mock.method(server, "setCustomProviders");
        const broadcasts = t.mock.method(server, "broadcastModelsChanged");
        const invalidations = t.mock.method(server, "invalidateCompactionCaches");
        const defaults = t.mock.method(server, "setDefaultModel");
        await write({ thinkingLevel: "low" });
        for (const spy of [custom, broadcasts, invalidations, defaults]) {
            assert.equal(spy.mock.callCount(), 0);
        }
    });

    it("invalidates existing workspace compaction caches after a valid change", async (t) => {
        const ws = await workspace();
        const invalidate = t.mock.method(ws, "invalidateCompactionCache");
        await write({ compaction: { enabled: false, threshold: 0.5 } });
        assert.deepEqual(readGlobalConfig().compaction, { enabled: false, threshold: 0.5 });
        assert.equal(invalidate.mock.callCount(), 1);
    });

    it("rejects invalid compaction before changing disk or runtime", async (t) => {
        const invalidations = t.mock.method(server, "invalidateCompactionCaches");
        const refresh = t.mock.method(server, "refreshConfiguration");
        await assert.rejects(
            write({ compaction: { threshold: 0.05 } }),
            /invalid compaction\.threshold/,
        );
        assert.equal(readFileSync(join(home, "taco.json"), "utf8"), "{}");
        assert.equal(invalidations.mock.callCount(), 0);
        assert.equal(refresh.mock.callCount(), 0);
    });

    it("changes existing workspace defaults when only the provider changes", async () => {
        const second = { ...CUSTOM_B, models: [{ id: "m1", contextWindow: 654321 }] };
        await write({
            customProviders: [CUSTOM_A, second],
            defaultModel: "m1",
            defaultProvider: CUSTOM_A.id,
        });
        const ws = await workspace();
        assert.equal(ws.defaultModel?.provider, CUSTOM_A.id);
        await write({ defaultProvider: CUSTOM_B.id });
        assert.equal(ws.defaultModel?.provider, CUSTOM_B.id);
        assert.equal(ws.defaultModel?.contextWindow, 654321);
        await write({ defaultModel: "m2", defaultProvider: CUSTOM_A.id });
        assert.equal(ws.defaultModel?.id, "m2");
    });

    it("propagates merged instructions to existing and future workspaces", async () => {
        await write({
            instructions: { enabled: true, files: { agentsMd: false, claudeMd: true } },
        });
        const existing = await workspace();
        await write({
            instructions: { enabled: false, files: { agentsMd: true }, inheritToSubagents: true },
        });
        const persisted = readGlobalConfig().instructions;
        assert.equal(persisted?.enabled, false);
        assert.equal(persisted?.files?.agentsMd, true);
        assert.equal(persisted?.files?.claudeMd, true);
        assert.equal(persisted?.inheritToSubagents, true);
        assert.deepEqual(existing.instructionsConfig, persisted);
        assert.deepEqual((await workspace()).instructionsConfig, persisted);
    });
});

describe("settings.corrupt", () => {
    /**
     * Regression coverage at the RPC boundary: when taco.json is malformed, the
     * settings.* / mcp.* handlers must surface a non-zero error frame instead
     * of crashing the process or silently returning an empty view. This is the
     * fix's contract as observed from the desktop's perspective.
     *
     * Background: the previous `readJsonOrEmpty` swallowed parse errors and
     * cached an empty object for the process lifetime. The desktop then showed
     * blank settings panes while the tools loaded from the same file at startup
     * kept working — fixed only by restarting the sidecar. After the fix the
     * handler must throw; the dispatch layer turns that into an `internal`
     * error frame so the client at least sees that something is wrong rather
     * than a silent empty view.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.corrupt.test.ts
     */

    const home = useTempTacoHome("settings-corrupt");
    let server: SidecarServer;
    beforeEach(() => {
        writeFileSync(join(home, "taco.json"), "{}");
        server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    });
    afterEach(async () => {
        await server.stop();
    });

    before(() => {
        registerBuiltinMethods();
    });

    describe("settings.get / mcp.* on corrupt taco.json", () => {
        function writeCorruptConfig(): void {
            writeFileSync(join(home, "taco.json"), "{this is not valid json", "utf8");
        }

        it("settings.get rejects with a parse error rather than returning an empty view", async () => {
            writeCorruptConfig();
            await assert.rejects(
                () => callMethod("settings.get", { server }),
                /Unexpected token|Expected|JSON/,
            );
        });

        it("mcp.listServers rejects on corrupt config (no silent empty list)", async () => {
            writeCorruptConfig();
            await assert.rejects(
                () => callMethod("mcp.listServers", { server, params: {} }),
                /Unexpected token|Expected|JSON/,
            );
        });

        it("settings.write rejects on corrupt config and does not overwrite the file", async () => {
            writeCorruptConfig();
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        server,
                        params: { global: { defaultProvider: "anthropic" } },
                    }),
                /Unexpected token|Expected|JSON/,
            );
            assert.equal(readFileSync(join(home, "taco.json"), "utf8"), "{this is not valid json");
        });
    });
});

describe("settings.mask", () => {
    /**
     * settings.get / settings.write handler — verifies the returned global
     * view never carries raw key material; `anthropicApiKey` / `openaiApiKey`
     * / `apiKeys.*` are mapped to `MaskedKey` via `toView`.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.mask.test.ts
     */

    useTempTacoHome("settings-mask");

    before(() => {
        // Register all builtin methods so settings.get is in the registry map.
        registerBuiltinMethods();
    });

    describe("settings handler — key masking", () => {
        it("maskKey keeps provider prefix + last 4 chars", () => {
            const long =
                "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            const m = maskKey(long);
            assert.equal(m.configured, true);
            assert.equal(m.mask, "sk-ant-…6789");
            // The full original must not appear in the mask.
            assert.ok(!m.mask?.includes(long));
        });

        it("maskKey handles sk-cp (minimax) underscore-containing keys", () => {
            const long = "sk-cp-GYH8_QwteRydXXWvLHlJIknHxWqlNiU1o_mXJ0GZwGvR_FHfYX5UqDTC3r";
            const m = maskKey(long);
            assert.equal(m.configured, true);
            // slice(0, 7) on "sk-cp-GYH..." is "sk-cp-G", last 4 is "TC3r"
            assert.equal(m.mask, "sk-cp-G…TC3r");
        });

        it("maskKey marks empty / very short inputs as not configured", () => {
            assert.deepEqual(maskKey(""), { configured: false });
            assert.deepEqual(maskKey(undefined), { configured: false });
            // Length <= head(7) + tail(4) + 1(separator) = 12 → would reveal too much
            assert.deepEqual(maskKey("short"), { configured: false });
        });

        it("toView maps raw shape to masked view, preserving non-key fields", () => {
            const raw = {
                defaultModel: "claude-sonnet",
                defaultProvider: "anthropic",
                thinkingLevel: "high" as const,
                anthropicApiKey: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv",
                openaiApiKey: "sk-OPENAI-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
                apiKeys: {
                    "minimax-cn":
                        "sk-cp-GYH8_QwteRydXXWvLHlJIknHxWqlNiU1o_mXJ0GZwGvR_FHfYX5UqDTC3r",
                },
                extensions: ["@taco/ext-a"],
                disabledExtensions: ["@taco/ext-b"],
                compaction: { enabled: false, threshold: 0.55 },
            };
            const v = toView(raw);
            assert.equal(v.defaultModel, "claude-sonnet");
            assert.equal(v.thinkingLevel, "high");
            assert.deepEqual(v.extensions, ["@taco/ext-a"]);
            assert.deepEqual(v.disabledExtensions, ["@taco/ext-b"]);
            assert.deepEqual(v.compaction, { enabled: false, threshold: 0.55 });
            assert.equal(v.anthropicApiKey?.configured, true);
            assert.equal(v.openaiApiKey?.configured, true);
            assert.equal(v.apiKeys?.["minimax-cn"]?.configured, true);
            // Concrete mask strings — see maskKey: head=7 + tail=4 + "…".
            assert.equal(v.anthropicApiKey?.mask, "sk-ant-…stuv");
            assert.equal(v.openaiApiKey?.mask, "sk-OPEN…DEFG");
            assert.equal(v.apiKeys?.["minimax-cn"]?.mask, "sk-cp-G…TC3r");
            // None of the raw key strings may appear anywhere in the view.
            const flat = JSON.stringify(v);
            assert.ok(!flat.includes(raw.anthropicApiKey));
            assert.ok(!flat.includes(raw.openaiApiKey));
            assert.ok(!flat.includes(raw.apiKeys["minimax-cn"]));
        });

        it("toView drops raw key fields when not present in raw shape", () => {
            const v = toView({ defaultModel: "x" });
            assert.equal(v.anthropicApiKey, undefined);
            assert.equal(v.openaiApiKey, undefined);
            assert.equal(v.apiKeys, undefined);
        });

        it("toView preserves commandPermissions unchanged", () => {
            const perms = { mode: "auto" as const, rules: ["ls"] as string[] };
            const v = toView({ commandPermissions: perms });
            assert.deepEqual(v.commandPermissions, perms);
        });

        // Regression: toView is an allowlist builder, so any field it forgets to
        // copy is silently stripped from settings.get — which left the MCP and
        // custom-provider settings panes empty even with entries in taco.json.
        it("toView carries mcpServers / customProviders / channels through", () => {
            // Secret-bearing fields (env/headers/command/args/url for MCP,
            // config for channels) are intentionally stripped — the protocol view
            // contract in @taco-ai/protocol config.ts is that these never cross
            // the IPC boundary. The test exercises the public-safe shape so a
            // regression that re-leaks them (e.g. by widening the Omit) is caught.
            const mcpServers = [
                {
                    id: "dbx",
                    transport: "stdio" as const,
                    command: "node",
                    args: ["/opt/dbx/server.js"],
                    env: { DBX_TOKEN: "super-secret" },
                    headers: { Authorization: "Bearer xyz" },
                    url: "https://internal.example.com",
                },
            ];
            const customProviders = [
                {
                    id: "custom:abcd1234",
                    name: "Local llama",
                    api: "chatcomplete" as const,
                    baseUrl: "http://127.0.0.1:1234/v1",
                    models: [{ id: "llama-3" }],
                },
            ];
            const channels = [
                {
                    channelId: "wechat",
                    manifest: { name: "wechat", version: "0.1.0" },
                    config: { iLinkToken: "another-secret" },
                },
            ];

            const v = toView({ mcpServers, customProviders, channels });

            assert.deepEqual(v.mcpServers, [{ id: "dbx", transport: "stdio" }]);
            assert.deepEqual(v.customProviders, customProviders);
            assert.deepEqual(v.channels, [
                {
                    channelId: "wechat",
                    manifest: { name: "wechat", version: "0.1.0" },
                },
            ]);
            // Belt-and-braces: make sure no secret field leaks through.
            for (const s of v.mcpServers ?? []) {
                assert.equal("command" in s, false);
                assert.equal("args" in s, false);
                assert.equal("env" in s, false);
                assert.equal("headers" in s, false);
                assert.equal("url" in s, false);
            }
            for (const c of v.channels ?? []) {
                assert.equal("config" in c, false);
            }
        });

        it("settings.get returns masked view via registered handler", async () => {
            // Save a raw shape with a key into the (temp) global config.
            saveGlobalConfig({
                anthropicApiKey: "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst",
                openaiApiKey: "sk-OPENAI-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
            });
            const result = await callMethod<{
                global: { anthropicApiKey?: unknown; openaiApiKey?: unknown };
            }>("settings.get");
            assert.ok(result, "expected settings.get to return a value");
            const anthropic = result.global.anthropicApiKey as {
                configured: boolean;
                mask?: string;
            };
            const openai = result.global.openaiApiKey as {
                configured: boolean;
                mask?: string;
            };
            // Concrete mask assertions — protect against a regression where
            // the handler still returns an object but stops masking (e.g.
            // `configured: false` everywhere).
            assert.equal(anthropic.configured, true);
            assert.equal(anthropic.mask, "sk-ant-…qrst");
            assert.equal(openai.configured, true);
            assert.equal(openai.mask, "sk-OPEN…DEFG");
            const flat = JSON.stringify(result);
            assert.ok(!flat.includes("sk-ant-api03-ABCDEFGHIJ"));
            assert.ok(!flat.includes("sk-OPENAI-abcdefghij"));
        });
    });
});
