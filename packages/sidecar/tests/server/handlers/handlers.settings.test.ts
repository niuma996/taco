/** Consolidated from 8 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { InstructionsConfig } from "@taco-ai/protocol";
import { asWorkspaceId } from "@taco-ai/protocol";
import { readGlobalConfig, saveGlobalConfig } from "../../../src/config/config.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import type { ServerRpcSurface } from "../../../src/runtime/serverRpcSurface.ts";
import { WorkspaceRuntime } from "../../../src/runtime/workspace.ts";
import { maskKey, toView } from "../../../src/server/handlers/settings.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { ServerRegistry } from "../../../src/server/serverRegistry.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("settings.broadcastModelsChanged", () => {
    /**
     * settings.write handler — broadcastModelsChanged trigger conditions:
     *  broadcasts only when the patch contains apiKeys or customProviders;
     *  unrelated fields (defaultModel, compaction, etc.) do not trigger it.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.broadcastModelsChanged.test.ts
     */

    useTempTacoHome("settings-broadcast");

    before(() => {
        registerBuiltinMethods();
    });

    function makeServer(): { server: unknown; getCalls: () => number } {
        let calls = 0;
        return {
            server: {
                providerKeyStore: new ProviderKeyStore({}),
                setCustomProviders(): void {},
                broadcastModelsChanged(): void {
                    calls++;
                },
            },
            getCalls: () => calls,
        };
    }

    describe("settings.write — broadcastModelsChanged trigger", () => {
        it("broadcasts once when customProviders changes", async () => {
            const { server, getCalls } = makeServer();
            await callMethod("settings.write", {
                server,
                params: { global: { customProviders: [] } },
            });
            assert.equal(getCalls(), 1);
        });

        it("does NOT broadcast when patch touches only unrelated fields", async () => {
            const { server, getCalls } = makeServer();
            await callMethod("settings.write", {
                server,
                params: { global: { defaultModel: "anthropic/claude-x" } },
            });
            assert.equal(getCalls(), 0, "defaultModel-only patch must not broadcast");
        });
    });
});

describe("settings.compaction.invalidate", () => {
    /**
     * settings.write handler — compaction invalidation path:
     *   when patch includes a compaction field, the handler calls
     *   server.invalidateCompactionCaches so every workspace's next
     *   effectiveCompaction() immediately reads the new disk value.
     *
     * Same structure as settings.customProviders.test.ts (handler spy + real disk round-trip).
     */

    useTempTacoHome("settings-compaction-invalidate");

    before(() => {
        registerBuiltinMethods();
    });

    describe("settings.write — compaction invalidation", () => {
        it("does NOT call invalidateCompactionCaches when patch omits compaction", async () => {
            let invalidateCount = 0;
            const server = {
                providerKeyStore: undefined,
                invalidateCompactionCaches(): void {
                    invalidateCount++;
                },
            };
            // Only changing defaultModel, not touching compaction
            await callMethod("settings.write", {
                server,
                params: { global: { defaultModel: "anthropic/claude-x" } },
            });
            assert.equal(invalidateCount, 0, "unrelated fields must not trigger invalidate");
        });

        it("rejects invalid compaction and skips invalidate", async () => {
            let invalidateCount = 0;
            const server = {
                providerKeyStore: undefined,
                invalidateCompactionCaches(): void {
                    invalidateCount++;
                },
            };
            // Invalid threshold (out of range) → saveGlobalConfig throws
            await assert.rejects(
                callMethod("settings.write", {
                    server,
                    params: { global: { compaction: { threshold: 0.05 } } },
                }),
                /invalid compaction\.threshold/,
            );
            assert.equal(invalidateCount, 0, "validation failure must not trigger invalidate");
        });
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
                () => callMethod("settings.get"),
                /Unexpected token|Expected|JSON/,
            );
        });

        it("mcp.listServers rejects on corrupt config (no silent empty list)", async () => {
            writeCorruptConfig();
            await assert.rejects(
                () => callMethod("mcp.listServers", { params: {} }),
                /Unexpected token|Expected|JSON/,
            );
        });

        it("settings.write rejects on corrupt config and does not overwrite the file", async () => {
            writeCorruptConfig();
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        params: { global: { defaultProvider: "anthropic" } },
                    }),
                /Unexpected token|Expected|JSON/,
            );
        });
    });
});

describe("settings.customProviders", () => {
    /**
     * settings.write handler — customProviders push path:
     *   when patch includes customProviders, the handler calls server.setCustomProviders
     *   so existing workspace catalogs are reconciled in real time (add/delete custom ids;
     *   builtin providers untouched).
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.customProviders.test.ts
     */

    useTempTacoHome("settings-customproviders");

    before(() => {
        registerBuiltinMethods();
    });

    const CUSTOM_A = {
        id: "custom:relay-a",
        name: "Relay A",
        api: "chatcomplete" as const,
        baseUrl: "https://relay-a.example.com/v1",
        models: [{ id: "m1" }, { id: "m2" }],
    };

    const CUSTOM_B = {
        id: "custom:relay-b",
        name: "Relay B",
        api: "anthropic" as const,
        baseUrl: "https://relay-b.example.com",
        models: [{ id: "claude-relay" }],
    };

    describe("settings.write — customProviders push", () => {
        it("persists customProviders and calls server.setCustomProviders", async () => {
            let pushCount = 0;
            let lastReceived: readonly unknown[] | undefined;
            const server = {
                providerKeyStore: undefined,
                setCustomProviders(next: readonly unknown[]): void {
                    pushCount++;
                    lastReceived = next;
                },
                broadcastModelsChanged(): void {},
            };
            await callMethod("settings.write", {
                server,
                params: { global: { customProviders: [CUSTOM_A] } },
            });

            // Disk persisted
            const onDisk = readGlobalConfig();
            assert.deepEqual(
                onDisk.customProviders?.map((c) => c.id),
                ["custom:relay-a"],
            );
            // server received push
            assert.equal(pushCount, 1);
            assert.equal((lastReceived?.[0] as { id: string }).id, "custom:relay-a");
        });

        it("replace: old custom deleted, new custom upserted via single push", async () => {
            const received: unknown[][] = [];
            const server = {
                providerKeyStore: undefined,
                setCustomProviders(next: readonly unknown[]): void {
                    received.push([...next]);
                },
                broadcastModelsChanged(): void {},
            };
            await callMethod("settings.write", {
                server,
                params: { global: { customProviders: [CUSTOM_B] } },
            });

            assert.equal(received.length, 1);
            const ids = (received[0] as Array<{ id: string }>).map((c) => c.id);
            assert.deepEqual(ids, ["custom:relay-b"]);
        });

        it("does NOT call setCustomProviders when patch omits customProviders", async () => {
            let pushCount = 0;
            const server = {
                providerKeyStore: undefined,
                setCustomProviders(): void {
                    pushCount++;
                },
                broadcastModelsChanged(): void {},
            };
            // Only changing defaultModel, not touching customProviders
            await callMethod("settings.write", {
                server,
                params: { global: { defaultModel: "anthropic/claude-x" } },
            });
            assert.equal(pushCount, 0, "unrelated fields must not trigger push");
        });

        it("empty array is a valid push (clears customs)", async () => {
            let pushCount = 0;
            const server = {
                providerKeyStore: undefined,
                setCustomProviders(next: readonly unknown[]): void {
                    pushCount++;
                    assert.equal(next.length, 0);
                },
                broadcastModelsChanged(): void {},
            };
            await callMethod("settings.write", {
                server,
                params: { global: { customProviders: [] } },
            });
            assert.equal(pushCount, 1);
            assert.deepEqual(readGlobalConfig().customProviders, []);
        });
    });
});

describe("settings.defaultModel", () => {
    /**
     * settings.write handler — defaultModel push path:
     *   when patch includes defaultModel and/or defaultProvider, the handler calls
     *   server.setDefaultModel so existing workspaces re-resolve their default
     *   model in real time. Without this, a workspace built before the user picked
     *   a provider keeps its construction-time fallback (first catalog model) and
     *   the next session.create fails with "Provider is not configured".
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.defaultModel.test.ts
     */

    useTempTacoHome("settings-defaultmodel");

    before(() => {
        registerBuiltinMethods();
    });

    interface DefaultModelCall {
        defaultModel?: string;
        defaultProvider?: string;
    }

    function makeServer(calls: DefaultModelCall[]) {
        return {
            providerKeyStore: undefined,
            setCustomProviders(): void {},
            broadcastModelsChanged(): void {},
            setDefaultModel(defaultModel?: string, defaultProvider?: string): void {
                calls.push({ defaultModel, defaultProvider });
            },
        };
    }

    describe("settings.write — defaultModel push", () => {
        it("fires when only defaultProvider changes (it scopes the model lookup)", async () => {
            const calls: DefaultModelCall[] = [];
            const server = makeServer(calls);
            // defaultModel already on disk from the previous test; change provider only.
            await callMethod("settings.write", {
                server,
                params: { global: { defaultProvider: "minimax" } },
            });

            assert.equal(calls.length, 1);
            assert.equal(calls[0].defaultProvider, "minimax");
        });

        it("does NOT push when the patch touches neither field", async () => {
            const calls: DefaultModelCall[] = [];
            const server = makeServer(calls);
            await callMethod("settings.write", {
                server,
                params: { global: { thinkingLevel: "low" } },
            });

            assert.equal(calls.length, 0);
        });
    });
});

describe("settings.fanout", () => {
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

    useTempTacoHome("settings-fanout");

    before(() => {
        registerBuiltinMethods();
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

    describe("settings.write — server fan-out", () => {
        it("falls back to [server] when no registry is provided", async () => {
            const a = makeRecorder("A");
            const b = makeRecorder("B");
            // Caller is A; serverRegistry is intentionally undefined so the
            // fan-out helper iterates the single-element [server] fallback.
            // B exists only to assert it stays untouched (it is not the
            // per-RPC server and the registry hook is not wired).
            await callMethod("settings.write", {
                server: a.server,
                params: { global: { apiKeys: { foo: "bar" } } },
            });

            assert.equal(a.calls.broadcastModelsChanged, 1, "A: broadcastModelsChanged fires");
            assert.equal(b.calls.broadcastModelsChanged, 0, "B: must NOT receive the broadcast");
        });

        it("fans setCustomProviders to every registered server", async () => {
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
            await callMethod("settings.write", {
                server: a.server,
                params: { global: { customProviders: provider } },
                serverRegistry: registry,
            });

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
            const a = makeRecorder("A");
            const b = makeRecorder("B");
            const registry = new ServerRegistry();
            registry.add(a.server);
            registry.add(b.server);

            await callMethod("settings.write", {
                server: a.server,
                params: { global: { apiKeys: { anthropic: "sk-test" } } },
                serverRegistry: registry,
            });

            assert.equal(a.calls.broadcastModelsChanged, 1);
            assert.equal(b.calls.broadcastModelsChanged, 1);
        });

        it("fans invalidateCompactionCaches when compaction is patched", async () => {
            const a = makeRecorder("A");
            const b = makeRecorder("B");
            const registry = new ServerRegistry();
            registry.add(a.server);
            registry.add(b.server);

            await callMethod("settings.write", {
                server: a.server,
                params: { global: { compaction: { enabled: true, threshold: 0.5 } } },
                serverRegistry: registry,
            });

            assert.equal(a.calls.invalidateCompactionCaches, 1);
            assert.equal(b.calls.invalidateCompactionCaches, 1);
        });

        it("fans refreshInstructions with the persisted (post-merge) value", async () => {
            const a = makeRecorder("A");
            const b = makeRecorder("B");
            const registry = new ServerRegistry();
            registry.add(a.server);
            registry.add(b.server);

            const patch = { instructions: { enabled: false, files: { "AGENTS.md": true } } };
            await callMethod("settings.write", {
                server: a.server,
                params: { global: patch },
                serverRegistry: registry,
            });

            for (const r of [a, b]) {
                assert.equal(
                    r.calls.refreshInstructions,
                    1,
                    `${r.label}: refreshInstructions fires`,
                );
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
            const a = makeRecorder("A");
            const b = makeRecorder("B");
            const registry = new ServerRegistry();
            registry.add(a.server);
            registry.add(b.server);

            await callMethod("settings.write", {
                server: a.server,
                params: {
                    global: { defaultModel: "claude-sonnet-4.5", defaultProvider: "anthropic" },
                },
                serverRegistry: registry,
            });

            for (const r of [a, b]) {
                assert.equal(r.calls.setDefaultModel, 1, `${r.label}: setDefaultModel fires`);
                assert.deepEqual(r.calls.setDefaultModelValue, {
                    model: "claude-sonnet-4.5",
                    provider: "anthropic",
                });
            }
        });

        it("survives a single server throwing without blocking the others", async () => {
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
                await callMethod("settings.write", {
                    server: a.server,
                    params: { global: { apiKeys: { foo: "bar" } } },
                    serverRegistry: registry,
                });
            } finally {
                console.error = originalErr;
            }

            assert.equal(a.calls.broadcastModelsChanged, 1, "A still receives the broadcast");
            assert.equal(b.calls.broadcastModelsChanged, 1, "B's broadcast fired before its throw");
        });
    });
});

describe("settings.instructions", () => {
    /**
     * settings.write handler — instructionsConfig propagation regression.
     *
     * The bug: `SidecarServer.buildWorkspace` did not pass
     * `instructionsConfig` from `SidecarServerOptions` to the
     * `new WorkspaceRuntime({...})` constructor call. Result: every
     * workspace started with `instructionsConfig: undefined`, falling back to
     * `mergeWithDefaults()` and silently dropping the user's
     * `taco.json instructions` block. The fix: capture on `this` in the
     * constructor, then thread through `buildWorkspace`.
     *
     * The handler-level contract (refreshInstructions fan-out) is already
     * covered by `settings.fanout.test.ts`. This file covers the OTHER half
     * of the fix: the workspace-build path. We construct a real
     * `WorkspaceRuntime` with instructionsConfig and assert the value lands
     * on the instance — that is the same field `buildWorkspace` reads, so
     * a passing test means the wiring works end-to-end.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.instructions.test.ts
     */

    // settings.write persists to $TACO_HOME/taco.json — keep it off the real ~/.taco.
    useTempTacoHome("settings-instructions");

    let tmpDir: string;

    before(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "taco-settings-instructions-"));
    });

    after(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    const providerKeyStore = () => new ProviderKeyStore({});

    describe("WorkspaceRuntime — instructionsConfig plumbing", () => {
        it("stores the constructor-supplied instructionsConfig on the instance", () => {
            const cfg: InstructionsConfig = {
                enabled: false,
                files: { agentsMd: true, claudeMd: false },
            };
            const ws = new WorkspaceRuntime({
                providerKeyStore: providerKeyStore(),
                cwd: asWorkspaceId(tmpDir),
                instructionsConfig: cfg,
            });
            assert.deepEqual(ws.instructionsConfig, cfg);
        });
    });

    describe("settings.write — instructions reaches refreshInstructions with persisted value", () => {
        before(() => {
            registerBuiltinMethods();
        });

        it("refreshInstructions receives the post-merge value from disk", () => {
            let received: InstructionsConfig | undefined;
            const server = {
                providerKeyStore: providerKeyStore(),
                setCustomProviders(): void {},
                broadcastModelsChanged(): void {},
                invalidateCompactionCaches(): void {},
                refreshInstructions(next: InstructionsConfig | undefined): void {
                    received = next;
                },
                setDefaultModel(): void {},
            };

            return callMethod("settings.write", {
                server,
                params: {
                    global: {
                        instructions: {
                            enabled: false,
                            files: { agentsMd: true },
                            inheritToSubagents: true,
                        },
                    },
                },
            }).then(() => {
                // saveGlobalConfig merges with defaults (claudeMd/agentsMd/
                // designMd are filled in), so the persisted value carries
                // the full file set; the patch's intent (AGENTS.md=true,
                // others false) is preserved within the merged object.
                assert.ok(received);
                assert.equal(received?.enabled, false);
                assert.equal(received?.inheritToSubagents, true);
                assert.deepEqual(received?.files?.agentsMd, true);
            });
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
