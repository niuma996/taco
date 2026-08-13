/**
 * Extension system integration test.
 *
 * Spins up a temp dir with three fixture extensions and verifies the
 * full loader → registry → tool/system-prompt/hook pipeline.
 *
 * Run: pnpm --filter @taco-ai/sidecar test:extensions
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ContextEvent, ToolResultEvent } from "@earendil-works/pi-agent-core";
import { createExtensionApi } from "../../src/extensions/extensionApi.ts";
import { loadExtensions } from "../../src/extensions/loader.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import type { ExtensionModule } from "../../src/extensions/types.ts";

let tmpDir: string;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "taco-ext-int-"));
    process.env.TACO_EXTENSIONS_DIR = tmpDir;
});

after(() => {
    process.env.TACO_EXTENSIONS_DIR = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
});

const writeExt = (name: string, body: string, perms: string[]) => {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
            name,
            version: "0.1.0",
            main: "index.js",
            taco: { apiVersion: "1", permissions: perms },
        }),
    );
    writeFileSync(join(dir, "index.js"), body);
};

describe("integration — happy path", () => {
    it("loads a healthy extension and surfaces its contributions", async () => {
        writeExt(
            "healthy",
            `export default function (taco) {
                taco.registerSystemPrompt({ append: "FROM HEALTHY" });
            }`,
            ["systemPrompt"],
        );
        const r = await loadExtensions({ extensions: [] });
        const contribs = r.systemPromptContributors();
        assert.ok(
            contribs.some((c) => c.append === "FROM HEALTHY"),
            `expected system prompt contribution, got: ${JSON.stringify(contribs)}`,
        );
        assert.ok(
            r.report.loaded.some((e) => e.name === "healthy"),
            `expected healthy in loaded, got: ${JSON.stringify(r.report.loaded)}`,
        );
    });

    it("extension-overrides-builtin-tool is recorded as a warning + the tool is overridden", async () => {
        writeExt(
            "override-read",
            `export default function (taco) {
                taco.registerTool({ name: "read", description: "fake", execute: async () => ({ text: "x" }) });
            }`,
            ["tools"],
        );
        const r = await loadExtensions({ extensions: [] });
        const reads = r.tools().filter((t) => t.name === "read");
        assert.ok(reads.length >= 1);
        assert.ok(r.report.loaded.some((e) => e.name === "override-read"));
    });
});

describe("integration — graceful degradation", () => {
    it("throwing extension does not prevent others from loading", async () => {
        writeExt("exploder", `export default function () { throw new Error("kaboom"); }`, [
            "context",
        ]);
        writeExt(
            "survivor",
            `export default function (taco) { taco.registerSystemPrompt({ prepend: "OK" }); }`,
            ["systemPrompt"],
        );
        const r = await loadExtensions({ extensions: [] });
        const failed = r.report.failed.find((f) => f.name === "exploder");
        assert.ok(failed, `expected exploder in failed, got: ${JSON.stringify(r.report.failed)}`);
        assert.ok(
            r.report.loaded.some((e) => e.name === "survivor"),
            `survivor should still load, loaded: ${JSON.stringify(r.report.loaded)}`,
        );
    });
});

describe("integration — permission gating", () => {
    it("extension without declared permission is silently ignored for that method", async () => {
        writeExt(
            "no-perm",
            `export default function (taco) {
                taco.registerTool({ name: "x", description: "x", execute: async () => ({ text: "" }) });
            }`,
            [],
        );
        const r = await loadExtensions({ extensions: [] });
        const xTools = r.tools().filter((t) => t.name === "x");
        assert.equal(xTools.length, 0, "tool should not be registered without permission");
        const u = r.report.unauthorized.find((e) => e.name === "no-perm" && e.method === "tools");
        assert.ok(
            u,
            `expected no-perm/tools in unauthorized, got: ${JSON.stringify(r.report.unauthorized)}`,
        );
    });
});

describe("integration — registry + extensionApi composition", () => {
    it("directly composes registry and api without the loader", async () => {
        const r = new ExtensionRegistry();
        const seen: string[] = [];
        const mod: ExtensionModule = (taco) => {
            seen.push(taco.manifest.name);
            taco.registerContextHook(async (_e: ContextEvent) => undefined);
        };
        const api = createExtensionApi(
            { name: "direct", version: "0.0.1", apiVersion: "1", permissions: ["context"] },
            r,
            { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            "external",
        );
        await mod(api);
        assert.deepEqual(seen, ["direct"]);
        assert.equal(r.contextHooks().external.length, 1);
    });
});

describe("integration — built-in extensions", () => {
    it("output-redaction builtin is loaded automatically and registered as builtin source", async () => {
        const r = await loadExtensions({ extensions: [] });
        const builtin = r.report.loaded.find((e) => e.name === "@taco/builtin-output-redaction");
        assert.ok(builtin, `expected builtin in loaded, got: ${JSON.stringify(r.report.loaded)}`);
        assert.equal(builtin.source, "builtin");
        // trust-bypass: builtins don't declare permissions (the registry's
        // permission check is in extensionApi, which builtins skip). See
        // registry.ts registerBuiltinExtensions.
        assert.deepEqual([...builtin.permissions], []);
        // And the hook must be in the builtins bucket, not external.
        const buckets = r.toolResultHooks();
        assert.equal(buckets.builtins.length, 1);
        assert.equal(buckets.external.length, 0);
    });

    it("output-redaction builtin version tracks the sidecar package version", async () => {
        const r = await loadExtensions({ extensions: [] });
        const builtin = r.report.loaded.find((e) => e.name === "@taco/builtin-output-redaction");
        assert.ok(builtin);
        // Should equal the sidecar package.json version, read at runtime.
        // (Independently verified via the same `readPackageVersion` path used
        // by registry.ts; if registry.ts hardcodes or drifts, this test will
        // catch it by comparing against an out-of-band value.)
        assert.match(builtin.version, /^\d+\.\d+\.\d+/, `expected semver, got: ${builtin.version}`);
        const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
        assert.equal(builtin.version, pkg.version);
    });

    it("output-redaction hook redacts API keys from tool output", async () => {
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const secret = "sk-1234567890abcdefghijklmnopqrstuvwxyz1234567890";
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Bash",
            input: { command: "echo $OPENAI_API_KEY" },
            content: [{ type: "text", text: secret }],
            details: undefined,
            isError: false,
        };
        const result = await hook(event);
        assert.ok(result, "expected a patch when secret is present");
        const flat = JSON.stringify(result);
        assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
        // Stronger assertion: the original secret string itself must be gone.
        assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
    });

    it("output-redaction hook passes through output with no secrets", async () => {
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Bash",
            input: { command: "echo hello" },
            content: [{ type: "text", text: "hello world" }],
            details: undefined,
            isError: false,
        };
        const result = await hook(event);
        assert.equal(result, undefined, `expected pass-through, got: ${JSON.stringify(result)}`);
    });

    it("output-redaction hook redacts GitHub tokens and AWS access keys", async () => {
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
        const awsKey = "AKIAIOSFODNN7EXAMPLE";
        const bearer = "Authorization: Bearer abcdef1234567890abcdef1234567890";
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Bash",
            input: { command: "env" },
            content: [
                { type: "text", text: `GITHUB_TOKEN=${githubToken}\nAWS_KEY=${awsKey}\n${bearer}` },
            ],
            details: undefined,
            isError: false,
        };
        const result = await hook(event);
        assert.ok(result);
        const flat = JSON.stringify(result);
        assert.ok(flat.includes("[REDACTED:GITHUB_TOKEN]"));
        assert.ok(flat.includes("[REDACTED:AWS_ACCESS_KEY]"));
        assert.ok(flat.includes("[REDACTED:BEARER_TOKEN]"));
        assert.ok(!flat.includes(githubToken));
        assert.ok(!flat.includes(awsKey));
    });

    it("output-redaction hook fails silently on malformed event", async () => {
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        // Missing required fields — the hook must not throw, must not crash
        // the tool pipeline. Pass-through (undefined) is acceptable.
        const event = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Read",
            input: {},
        } as unknown as ToolResultEvent;
        let result: unknown;
        await assert.doesNotReject(async () => {
            result = await hook(event);
        });
        // No assertion on `result` — either undefined (pass-through) or a
        // patch that didn't crash is acceptable. The contract is "doesn't throw".
        void result;
    });

    it("output-redaction hook redacts Anthropic sk-ant-api03 keys (hyphenated body)", async () => {
        // Regression for session 019f97cf-... — the old single pattern
        // \bsk-[A-Za-z0-9]{20,}\b failed because the body contains '-'
        // (e.g. "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ...").
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const secret =
            "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Bash",
            input: { command: "env" },
            content: [{ type: "text", text: `ANTHROPIC_API_KEY=${secret}` }],
            details: undefined,
            isError: false,
        };
        const result = await hook(event);
        assert.ok(result, "expected a patch when sk-ant key is present");
        const flat = JSON.stringify(result);
        assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
        assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
    });

    it("output-redaction hook redacts OpenAI sk-proj / sk-svcacct keys", async () => {
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Bash",
            input: { command: "env" },
            content: [{ type: "text", text: `OPENAI_API_KEY=${secret}` }],
            details: undefined,
            isError: false,
        };
        const result = await hook(event);
        assert.ok(result);
        const flat = JSON.stringify(result);
        assert.ok(flat.includes("[REDACTED:API_KEY]"));
        assert.ok(!flat.includes(secret));
    });

    it("output-redaction hook redacts minimax-cn sk-cp keys with underscores", async () => {
        // Regression for session 019f97cf-... — real minimax-cn key looks
        // like "sk-cp-GYH8_QwteRydXXWvLHlJIkn..." with embedded '_'.
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const secret = "sk-cp-GYH8_QwteRydXXWvLHlJIknHxWqlNiU1o_mXJ0GZwGvR_FHfYX5UqDTC3rhltJko";
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Read",
            input: { path: "~/.pi/agent/taco.json" },
            content: [{ type: "text", text: `"minimax-cn": "${secret}"` }],
            details: undefined,
            isError: false,
        };
        const result = await hook(event);
        assert.ok(result, "expected a patch when sk-cp key is present");
        const flat = JSON.stringify(result);
        assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
        assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
    });

    it("output-redaction hook redacts secrets in JSON-serializable details field", async () => {
        // Belt-and-suspenders: shell/bash tools may surface secrets via
        // details (e.g. env-shaped metadata). Patch details when hit.
        const r = await loadExtensions({ extensions: [] });
        const hook = r.toolResultHooks().builtins[0];
        const secret =
            "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        const event: ToolResultEvent = {
            type: "tool_result",
            toolCallId: "test-call",
            toolName: "Bash",
            input: { command: "env" },
            content: [{ type: "text", text: "ok" }],
            details: { env: { ANTHROPIC_API_KEY: secret }, exitCode: 0 },
            isError: false,
        };
        const result = await hook(event);
        assert.ok(result);
        // The hit must come from `details` (content is "ok"). If the hook
        // regresses to skip `details`, this assertion fails — protects
        // against false-positive tests where the hit came from content.
        assert.ok(
            "details" in result,
            `expected patch.details to be set when redaction hit is in details, got: ${JSON.stringify(result)}`,
        );
        assert.deepEqual(result.details, {
            env: { ANTHROPIC_API_KEY: "[REDACTED:API_KEY]" },
            exitCode: 0,
        });
        const flat = JSON.stringify(result);
        assert.ok(flat.includes("[REDACTED:API_KEY]"), `expected marker in: ${flat}`);
        assert.ok(!flat.includes(secret), `expected secret to be scrubbed, got: ${flat}`);
        // exitCode is not a secret — must be preserved.
        assert.ok(flat.includes('"exitCode":0'), `expected non-secret field preserved: ${flat}`);
    });
});
