/** Consolidated from 4 test files; behaviour unchanged. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadAgents } from "../../src/agents/loadAgents.ts";
import type { ImWorkspacePolicy } from "../../src/channels/imWorkspacePolicy.ts";
import { saveGlobalConfig } from "../../src/config/config.ts";
import { tacoHome } from "../../src/config/tacoHome.ts";
import { ExtensionRegistry } from "../../src/extensions/registry.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { resolveImExecutionCwd } from "../../src/server/imExecutionCwd.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

describe("server.agents", () => {
    /**
     * verify that loadAgents — called from the production-style path —
     * finds the builtin agents under src/agents/builtin.
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/server.agents.test.ts
     */

    describe("server.ts agent loading path", () => {
        it("loads the builtin agents from src/agents/builtin", async () => {
            const builtinDir = join(import.meta.dirname, "..", "..", "src", "agents", "builtin");
            // userDirs: [] — intentionally skips host ~/.claude / ~/.pi / ~/.taco/agents
            // to avoid host-fs drift on dev machines contaminating the builtin assertions.
            const agents = await loadAgents({ builtinDir, userDirs: [] });
            const types = agents.map((a) => a.agentType).sort();
            assert.deepEqual(types, ["explorer", "reviewer", "verification"]);
        });
    });
});

describe("imExecutionCwd", () => {
    const ROUTE = { channelId: "wechat", peerId: "u1", chatId: "c1" };
    const DEFAULT_POLICY: ImWorkspacePolicy = {
        tools: { fsTools: "deny", shell: "deny" },
        commands: { mode: "ask" },
        executionDir: { mode: "shared" },
    };

    describe("resolveImExecutionCwd", () => {
        it("default policy returns the channel scratch and marks it shared", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: DEFAULT_POLICY,
            });
            assert.equal(out.shared, true);
            assert.ok(out.executionCwd.endsWith(`${join("wechat", "scratch")}`));
            assert.equal(out.warning, undefined);
        });

        it("per-chat mode isolates to a per-chat dir and creates it", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: { ...DEFAULT_POLICY, executionDir: { mode: "per-chat" } },
            });
            assert.equal(out.shared, false);
            assert.ok(out.executionCwd.includes("chats"));
            assert.ok(out.executionCwd.endsWith("scratch"));
            // Directory is created eagerly so tools can write immediately.
            assert.ok(existsSync(out.executionCwd));
        });

        it("a custom directory is used as-is", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const bound = mkdtempSync(join(tmpdir(), "im-bound-"));
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: {
                    ...DEFAULT_POLICY,
                    executionDir: { mode: "custom", path: bound },
                },
            });
            assert.equal(out.executionCwd, bound);
            assert.equal(out.shared, false);
        });

        it("a custom directory pointing at a file falls back to the shared scratch with a warning", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const file = join(home, "not-a-dir");
            writeFileSync(file, "x");
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: { ...DEFAULT_POLICY, executionDir: { mode: "custom", path: file } },
            });
            assert.equal(out.shared, true);
            assert.ok(out.warning);
            assert.ok(out.warning.includes(file));
        });

        it("a custom directory pointing at a nonexistent path falls back with a warning", () => {
            const home = mkdtempSync(join(tmpdir(), "im-exec-"));
            const missing = join(home, "no", "such", "dir");
            const out = resolveImExecutionCwd({
                sessionsRoot: join(home, "sessions", "im", "wechat"),
                route: ROUTE,
                policy: { ...DEFAULT_POLICY, executionDir: { mode: "custom", path: missing } },
            });
            assert.equal(out.shared, true);
            assert.ok(out.warning);
        });
    });
});

describe("imPolicyGlobalRules", () => {
    useTempTacoHome("im-policy-global-rules");

    function serverWithExtensionRule(rule: string): SidecarServer {
        const extensionRegistry = new ExtensionRegistry();
        extensionRegistry.addWorkspaceActivator("builtin", "@taco/test-ext", () => ({
            commandPermissionRules: [rule],
        }));
        return new SidecarServer({ providerKeyStore: new ProviderKeyStore({}), extensionRegistry });
    }

    describe("imPolicy.get global rule group", () => {
        it("includes extension allow-rules the runtime broker appends", async () => {
            saveGlobalConfig({
                commandPermissions: { mode: "ask", allow: ["ls"], deny: ["rm *"] },
            });
            const result = await serverWithExtensionRule("officecli *").imPolicy.get({
                channelId: "wechat",
            });
            assert.deepEqual(result.rules.allow[0], {
                source: "global",
                rules: ["ls", "officecli *"],
                editable: false,
            });
            assert.deepEqual(result.rules.deny[0], {
                source: "global",
                rules: ["rm *"],
                editable: false,
            });
        });

        it("still loads the editor when taco.json commandPermissions is malformed", async () => {
            writeFileSync(
                join(tacoHome(), "taco.json"),
                JSON.stringify({ commandPermissions: { allow: "not-an-array" } }),
            );
            // A no-op save drops the in-process config cache so the hand edit is read.
            saveGlobalConfig({});
            const result = await serverWithExtensionRule("officecli *").imPolicy.get({
                channelId: "wechat",
            });
            assert.deepEqual(result.rules.allow[0]?.rules, ["officecli *"]);
            assert.deepEqual(result.rules.deny, [{ source: "channel", rules: [], editable: true }]);
        });
    });
});
