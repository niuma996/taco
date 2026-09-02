/**
 * settings.write handler — multi-server fan-out:
 *   when a `ServerRegistry` is provided on MethodCtx, every one of the
 *   five setters (setCustomProviders, setDefaultModel,
 *   invalidateCompactionCaches, refreshInstructions,
 *   broadcastModelsChanged) must reach every registered server in the
 *   process. Without a registry, the handler falls back to the per-RPC
 *   `server` argument — single-element iteration, byte-identical to the
 *   pre-fix behaviour.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.fanout.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readGlobalConfig } from "../../../src/config/config.ts";
import { ProviderKeyStore } from "../../../src/runtime/providerKeyStore.ts";
import type { ServerRpcSurface } from "../../../src/runtime/serverRpcSurface.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { ServerRegistry } from "../../../src/server/serverRegistry.ts";

let tmpDir: string;
let prevTacoHome: string | undefined;

before(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-fanout-"));
    process.env.TACO_HOME = tmpDir;
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

/** Recorder stub. Tracks every call on every method we expect to fan out. */
function makeRecorder(label: string) {
    const calls = {
        setCustomProviders: 0,
        broadcastModelsChanged: 0,
        invalidateCompactionCaches: 0,
        refreshInstructions: 0,
        setDefaultModel: 0,
        setCustomProvidersValue: undefined as unknown,
        refreshInstructionsValue: undefined as unknown,
        setDefaultModelValue: undefined as { model?: string; provider?: string } | undefined,
        lastInstructionsInstructions: undefined as unknown,
    };
    // Real ProviderKeyStore so the handler's unconditional
    // providerKeyStore.update() call (when apiKeys is in the patch) doesn't
    // NPE — the handler reads/writes the in-memory store before any of our
    // fan-out setters run.
    // ServerRpcSurface has 15+ methods; the fan-out helper only
    // touches five of them. Cast through `unknown` so this test
    // focuses on those five without duplicating the whole surface.
    const server = {
        providerKeyStore: new ProviderKeyStore({}),
        setCustomProviders(next: readonly unknown[]) {
            calls.setCustomProviders++;
            calls.setCustomProvidersValue = next;
        },
        setDefaultModel(defaultModel: string | undefined, defaultProvider: string | undefined) {
            calls.setDefaultModel++;
            calls.setDefaultModelValue = { model: defaultModel, provider: defaultProvider };
        },
        invalidateCompactionCaches() {
            calls.invalidateCompactionCaches++;
        },
        refreshInstructions(next: unknown) {
            calls.refreshInstructions++;
            calls.refreshInstructionsValue = next;
            calls.lastInstructionsInstructions = next;
        },
        broadcastModelsChanged() {
            calls.broadcastModelsChanged++;
        },
    } as unknown as ServerRpcSurface;
    return { server, calls, label };
}

type HandlerCtx = Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];

function makeCtx(
    server: unknown,
    global: Record<string, unknown>,
    serverRegistry?: ServerRegistry,
): HandlerCtx {
    const base = {
        id: "test",
        workspace: undefined as never,
        cwd: undefined as never,
        server,
        params: { global },
    };
    if (serverRegistry !== undefined) {
        (base as { serverRegistry?: ServerRegistry }).serverRegistry = serverRegistry;
    }
    return base as unknown as HandlerCtx;
}

describe("settings.write — server fan-out", () => {
    it("falls back to [server] when no registry is provided", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        // Caller is A; serverRegistry is intentionally undefined so the
        // fan-out helper iterates the single-element [server] fallback.
        // B exists only to assert it stays untouched (it is not the
        // per-RPC server and the registry hook is not wired).
        await reg.handler(makeCtx(a.server, { apiKeys: { foo: "bar" } }));

        assert.equal(a.calls.broadcastModelsChanged, 1, "A: broadcastModelsChanged fires");
        assert.equal(b.calls.broadcastModelsChanged, 0, "B: must NOT receive the broadcast");
    });

    it("fans setCustomProviders to every registered server", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        const c = makeRecorder("C");
        const registry = new ServerRegistry();
        registry.add(a.server);
        registry.add(b.server);
        registry.add(c.server);

        const provider = [
            {
                id: "custom:openrouter",
                name: "OpenRouter",
                baseUrl: "https://x.test",
                api: "chatcomplete",
                models: [{ id: "openrouter/test", name: "test" }],
            },
        ];
        await reg.handler(makeCtx(a.server, { customProviders: provider }, registry));

        for (const r of [a, b, c]) {
            assert.equal(r.calls.setCustomProviders, 1, `${r.label}: setCustomProviders fires`);
            assert.deepEqual(
                r.calls.setCustomProvidersValue,
                provider,
                `${r.label}: setCustomProviders receives the persisted value`,
            );
        }
    });

    it("fans broadcastModelsChanged to every server when apiKeys change", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        const registry = new ServerRegistry();
        registry.add(a.server);
        registry.add(b.server);

        await reg.handler(makeCtx(a.server, { apiKeys: { anthropic: "sk-test" } }, registry));

        assert.equal(a.calls.broadcastModelsChanged, 1);
        assert.equal(b.calls.broadcastModelsChanged, 1);
    });

    it("fans invalidateCompactionCaches when compaction is patched", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        const registry = new ServerRegistry();
        registry.add(a.server);
        registry.add(b.server);

        await reg.handler(
            makeCtx(a.server, { compaction: { enabled: true, threshold: 0.5 } }, registry),
        );

        assert.equal(a.calls.invalidateCompactionCaches, 1);
        assert.equal(b.calls.invalidateCompactionCaches, 1);
    });

    it("fans refreshInstructions with the persisted (post-merge) value", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        const registry = new ServerRegistry();
        registry.add(a.server);
        registry.add(b.server);

        const patch = { instructions: { enabled: false, files: { "AGENTS.md": true } } };
        await reg.handler(makeCtx(a.server, patch, registry));

        for (const r of [a, b]) {
            assert.equal(r.calls.refreshInstructions, 1, `${r.label}: refreshInstructions fires`);
            assert.deepEqual(
                r.calls.refreshInstructionsValue,
                { enabled: false, files: { "AGENTS.md": true } },
                `${r.label}: receives persisted value`,
            );
        }
        // Disk was also persisted (the handler's primary contract).
        assert.deepEqual(readGlobalConfig().instructions, {
            enabled: false,
            files: { "AGENTS.md": true },
        });
    });

    it("fans setDefaultModel when defaultModel/defaultProvider change", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        const registry = new ServerRegistry();
        registry.add(a.server);
        registry.add(b.server);

        await reg.handler(
            makeCtx(
                a.server,
                { defaultModel: "claude-sonnet-4.5", defaultProvider: "anthropic" },
                registry,
            ),
        );

        for (const r of [a, b]) {
            assert.equal(r.calls.setDefaultModel, 1, `${r.label}: setDefaultModel fires`);
            assert.deepEqual(r.calls.setDefaultModelValue, {
                model: "claude-sonnet-4.5",
                provider: "anthropic",
            });
        }
    });

    it("survives a single server throwing without blocking the others", async () => {
        const reg = getRegisteredMethod("settings.write");
        assert.ok(reg);

        const a = makeRecorder("A");
        const b = makeRecorder("B");
        // Wrap B's broadcast so it throws — fan-out helper must catch +
        // continue so A still receives the patch.
        const origBroadcast = b.server.broadcastModelsChanged.bind(b.server);
        b.server.broadcastModelsChanged = () => {
            origBroadcast();
            throw new Error("synthetic broadcast failure");
        };
        const registry = new ServerRegistry();
        registry.add(a.server);
        registry.add(b.server);

        // Suppress console.error noise from the fan-out helper's try/catch
        // — the assertion below is what matters.
        const originalErr = console.error;
        console.error = () => {};
        try {
            await reg.handler(makeCtx(a.server, { apiKeys: { foo: "bar" } }, registry));
        } finally {
            console.error = originalErr;
        }

        assert.equal(a.calls.broadcastModelsChanged, 1, "A still receives the broadcast");
        assert.equal(b.calls.broadcastModelsChanged, 1, "B's broadcast fired before its throw");
    });
});
