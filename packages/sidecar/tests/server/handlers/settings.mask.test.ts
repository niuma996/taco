/**
 * settings.get / settings.write handler — verifies the returned global
 * view never carries raw key material; `anthropicApiKey` / `openaiApiKey`
 * / `apiKeys.*` are mapped to `MaskedKey` via `toView`.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.mask.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { saveGlobalConfig } from "../../../src/config/config.ts";
import { maskKey, toView } from "../../../src/server/handlers/settings.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    // Hermetic: point TACO_HOME at a temp dir so saveGlobalConfig touches
    // only the temp file, never the real ~/.taco/taco.json.
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-mask-"));
    process.env.TACO_HOME = tmpDir;
    // Register all builtin methods so settings.get is in the registry map.
    registerBuiltinMethods();
});

after(() => {
    if (prevTacoHome === undefined) {
        Reflect.deleteProperty(process.env, "TACO_HOME");
    } else {
        process.env.TACO_HOME = prevTacoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
});

describe("settings handler — key masking", () => {
    it("maskKey keeps provider prefix + last 4 chars", () => {
        const long = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
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
                "minimax-cn": "sk-cp-GYH8_QwteRydXXWvLHlJIknHxWqlNiU1o_mXJ0GZwGvR_FHfYX5UqDTC3r",
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
        const reg = getRegisteredMethod("settings.get");
        assert.ok(reg, "settings.get must be registered after registerBuiltinMethods()");
        // settings.get only reads `params` from ctx; the rest can be dummies.
        const result = (await reg.handler({
            id: "test",
            workspace: undefined as never,
            cwd: undefined as never,
            server: undefined as never,
            params: undefined,
        })) as { global: { anthropicApiKey?: unknown; openaiApiKey?: unknown } };
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
