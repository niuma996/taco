/** Consolidated from 3 test files; behaviour unchanged. */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { before, beforeEach, describe, it, mock } from "node:test";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { readGlobalConfig } from "../../../src/config/config.ts";
import { buildCustomProvider } from "../../../src/runtime/models/customProvider.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import { sidecarVersion } from "../../../src/runtime/runtimeResources.ts";
import type { performModelsRequest as RealPerform } from "../../../src/server/handlers/providerModels.ts";
import {
    extractModelIds,
    performModelsRequest,
    registerProviderModelsHandlers,
    TimeoutError,
} from "../../../src/server/handlers/providerModels.ts";
import type { ProbeFn } from "../../../src/server/handlers/providerTest.ts";
import {
    classifyMessage,
    performProbe,
    registerProviderTestHandlers,
} from "../../../src/server/handlers/providerTest.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";
import { useTempTacoHome } from "../../_helpers/tempTacoHome.ts";

describe("settings.providerExtraModels", () => {
    /**
     * settings.write handler — providerExtraModels push path:
     * when patch includes providerExtraModels, the handler persists it, calls
     * server.setProviderExtraModels so existing workspace catalogs re-register
     * wrapped built-ins, and broadcasts models.changed.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/settings.providerExtraModels.test.ts
     */

    useTempTacoHome("settings-providerextramodels");

    before(() => {
        registerBuiltinMethods();
    });

    function makeServer(track: { pushes: unknown[][]; broadcasts: number }) {
        return {
            providerKeyStore: undefined,
            setProviderModelEdits(extras: unknown, hidden: unknown): void {
                track.pushes.push([extras, hidden]);
            },
            broadcastModelsChanged(): void {
                track.broadcasts++;
            },
        };
    }

    describe("settings.write — providerExtraModels push", () => {
        it("persists providerExtraModels and calls server.setProviderModelEdits", async () => {
            const track = { pushes: [] as unknown[][], broadcasts: 0 };
            await callMethod("settings.write", {
                server: makeServer(track),
                params: { global: { providerExtraModels: { minimax: [{ id: "MiniMax-M3.1" }] } } },
            });

            assert.deepEqual(readGlobalConfig().providerExtraModels, {
                minimax: [{ id: "MiniMax-M3.1" }],
            });
            assert.equal(track.pushes.length, 1);
            // Both halves travel together so the registry wrapper never loses one.
            assert.deepEqual(track.pushes[0], [{ minimax: [{ id: "MiniMax-M3.1" }] }, {}]);
            assert.ok(track.broadcasts > 0, "models.changed broadcast fired");
        });

        it("whole-object replace: a second write replaces the first", async () => {
            const track = { pushes: [] as unknown[][], broadcasts: 0 };
            await callMethod("settings.write", {
                server: makeServer(track),
                params: { global: { providerExtraModels: { deepseek: [{ id: "d-1" }] } } },
            });
            assert.deepEqual(readGlobalConfig().providerExtraModels, { deepseek: [{ id: "d-1" }] });
        });

        it("settings.get view passes providerExtraModels through", async () => {
            const result = (await callMethod("settings.get", { server: {} })) as {
                global: { providerExtraModels?: unknown };
            };
            assert.deepEqual(result.global.providerExtraModels, { deepseek: [{ id: "d-1" }] });
        });

        it("rejects custom: prefixed provider ids", async () => {
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        server: makeServer({ pushes: [], broadcasts: 0 }),
                        params: { global: { providerExtraModels: { "custom:x": [{ id: "m" }] } } },
                    }),
                /custom provider/,
            );
        });

        it("rejects empty model arrays and duplicate model ids", async () => {
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        server: makeServer({ pushes: [], broadcasts: 0 }),
                        params: { global: { providerExtraModels: { minimax: [] } } },
                    }),
                /non-empty array/,
            );
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        server: makeServer({ pushes: [], broadcasts: 0 }),
                        params: {
                            global: {
                                providerExtraModels: { minimax: [{ id: "m" }, { id: "m" }] },
                            },
                        },
                    }),
                /duplicate model id/,
            );
        });

        it("does NOT call setProviderModelEdits when patch omits both maps", async () => {
            const track = { pushes: [] as unknown[][], broadcasts: 0 };
            await callMethod("settings.write", {
                server: makeServer(track),
                params: { global: { defaultModel: "m-x" } },
            });
            assert.equal(track.pushes.length, 0);
        });
    });

    describe("settings.write — providerHiddenModels push", () => {
        it("persists providerHiddenModels and pushes it with the current extras", async () => {
            const track = { pushes: [] as unknown[][], broadcasts: 0 };
            await callMethod("settings.write", {
                server: makeServer(track),
                params: { global: { providerHiddenModels: { minimax: ["MiniMax-M2"] } } },
            });

            assert.deepEqual(readGlobalConfig().providerHiddenModels, { minimax: ["MiniMax-M2"] });
            assert.equal(track.pushes.length, 1);
            // Extras unchanged by this patch still ride along — the registry
            // applies hide + extras in one wrapper.
            assert.deepEqual(track.pushes[0], [
                { deepseek: [{ id: "d-1" }] },
                { minimax: ["MiniMax-M2"] },
            ]);
        });

        it("settings.get view passes providerHiddenModels through", async () => {
            const result = (await callMethod("settings.get", { server: {} })) as {
                global: { providerHiddenModels?: unknown };
            };
            assert.deepEqual(result.global.providerHiddenModels, { minimax: ["MiniMax-M2"] });
        });

        it("rejects custom: prefixed provider ids and empty arrays", async () => {
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        server: makeServer({ pushes: [], broadcasts: 0 }),
                        params: { global: { providerHiddenModels: { "custom:x": ["m"] } } },
                    }),
                /custom provider/,
            );
            await assert.rejects(
                () =>
                    callMethod("settings.write", {
                        server: makeServer({ pushes: [], broadcasts: 0 }),
                        params: { global: { providerHiddenModels: { minimax: [] } } },
                    }),
                /non-empty array/,
            );
        });
    });

    describe("providers.revealKey", () => {
        it("returns the plaintext key from the provider key store", async () => {
            const server = {
                providerKeyStore: {
                    get: (id: string) => (id === "minimax" ? "sk-plain-text" : undefined),
                },
            };
            const result = (await callMethod("providers.revealKey", {
                server,
                params: { workspace: "/tmp/ws", providerId: "minimax" },
            })) as { key: string | null };
            assert.equal(result.key, "sk-plain-text");
        });

        it("returns null when no key is configured", async () => {
            const server = { providerKeyStore: { get: () => undefined } };
            const result = (await callMethod("providers.revealKey", {
                server,
                params: { workspace: "/tmp/ws", providerId: "nope" },
            })) as { key: string | null };
            assert.equal(result.key, null);
        });

        it("rejects an empty providerId with invalid_params", async () => {
            await assert.rejects(
                () =>
                    callMethod("providers.revealKey", {
                        server: { providerKeyStore: { get: () => undefined } },
                        params: { workspace: "/tmp/ws", providerId: " " },
                    }),
                /providerId/,
            );
        });
    });
});

describe("provider.listModels", () => {
    /**
     * provider.listModels handler — invokes the registered top-level RPC and
     * asserts the schema-tolerance / protocol-branch / error-reason logic.
     *
     * Network is stubbed by re-registering the handler with a fake
     * `performModelsRequest` injected through deps; fetch is never called.
     *
     * `performModelsRequest` itself (the outbound HTTP builder) is exercised
     * separately in the lower "performModelsRequest" suite via node:test mock
     * on globalThis.fetch — that one cannot go through deps without altering
     * the production signature just to make it observable.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/provider.listModels.test.ts
     */

    type Stub = (
        url: string,
        apiKey: string,
        api: string,
        signal: AbortSignal,
    ) => Promise<FakeResponse>;

    interface FakeResponse {
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
    }

    let currentStub: Stub | undefined;

    function fakeResponse(body: unknown, status = 200): FakeResponse {
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
        };
    }

    before(() => {
        registerBuiltinMethods();
    });

    beforeEach(() => {
        registerProviderModelsHandlers({
            performModelsRequest: ((
                url: string,
                apiKey: string,
                api: string,
                signal: AbortSignal,
            ) => {
                const stub = currentStub;
                if (!stub) throw new Error("test forgot to set currentStub");
                return stub(url, apiKey, api, signal);
            }) as unknown as typeof RealPerform,
        });
    });

    async function invoke(params: unknown, server: unknown = {}): Promise<unknown> {
        return callMethod("provider.listModels", { server, params });
    }

    describe("provider.listModels handler", () => {
        it("fetches the same catalog for api=response as for chatcomplete", async () => {
            // The Responses API differs only in its inference endpoint; the model
            // catalog is still {baseUrl}/models with Bearer auth.
            let captured = "";
            currentStub = async (url, apiKey) => {
                captured = url;
                assert.equal(apiKey, "k");
                return fakeResponse({ data: [{ id: "gpt-5-codex" }] });
            };
            const result = (await invoke({
                baseUrl: "https://api.openai.com/v1",
                api: "response",
                apiKey: "k",
            })) as { ok: true; models: string[] };
            assert.equal(result.ok, true);
            assert.equal(captured, "https://api.openai.com/v1/models");
            assert.deepEqual(result.models, ["gpt-5-codex"]);
        });

        it("fetches anthropic catalogs via {baseUrl}/v1/models", async () => {
            let captured = "";
            currentStub = async (url) => {
                captured = url;
                return fakeResponse({ data: [{ id: "claude-a" }] });
            };
            const result = (await invoke({
                baseUrl: "https://api.anthropic.com",
                api: "anthropic",
                apiKey: "k",
            })) as { ok: true; models: string[] };
            assert.equal(result.ok, true);
            assert.equal(captured, "https://api.anthropic.com/v1/models");
            assert.deepEqual(result.models, ["claude-a"]);
        });

        it("does not double-append /v1 when the anthropic baseUrl already ends with it", async () => {
            let captured = "";
            currentStub = async (url) => {
                captured = url;
                return fakeResponse({ data: [] });
            };
            await invoke({ baseUrl: "https://gateway.example/v1", api: "anthropic", apiKey: "k" });
            assert.equal(captured, "https://gateway.example/v1/models");
        });

        it("rejects empty baseUrl with invalid_params", async () => {
            await assert.rejects(
                () => invoke({ baseUrl: "  ", api: "chatcomplete", apiKey: "k" }),
                /baseUrl/,
            );
        });

        it("rejects empty apiKey with invalid_params", async () => {
            await assert.rejects(
                () => invoke({ baseUrl: "https://x", api: "chatcomplete", apiKey: "" }),
                /apiKey/,
            );
        });

        it("rejects unknown api value", async () => {
            await assert.rejects(
                () => invoke({ baseUrl: "https://x", api: "wat", apiKey: "k" }),
                /unsupported api/,
            );
        });

        it("returns ok=true with id list for the standard {data: [{id}]} shape", async () => {
            currentStub = async () =>
                fakeResponse({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
            const result = (await invoke({
                baseUrl: "https://api.example/v1",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: true;
                models: string[];
            };
            assert.equal(result.ok, true);
            assert.deepEqual(result.models, ["gpt-4o", "gpt-4o-mini"]);
        });

        it("tolerates the bare array shape", async () => {
            currentStub = async () => fakeResponse([{ id: "llm-a" }, { id: "llm-b" }]);
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: true;
                models: string[];
            };
            assert.deepEqual(result.models, ["llm-a", "llm-b"]);
        });

        it("tolerates the {models: [...]} shape and falls back to name when id is missing", async () => {
            currentStub = async () =>
                fakeResponse({ models: [{ name: "alpha" }, { id: "beta" }, { id: "" }] });
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: true;
                models: string[];
            };
            assert.deepEqual(result.models, ["alpha", "beta"]);
        });

        it("returns invalid-response when the body has no recognizable model list", async () => {
            currentStub = async () => fakeResponse({ unrelated: true });
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: false;
                reason: string;
            };
            assert.equal(result.reason, "invalid-response");
        });

        it("returns invalid-response when the body is not JSON", async () => {
            currentStub = async () => ({
                ok: true,
                status: 200,
                json: async () => {
                    throw new SyntaxError("Unexpected token");
                },
            });
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: false;
                reason: string;
            };
            assert.equal(result.reason, "invalid-response");
        });

        it("returns http-error with the status when the server rejects", async () => {
            currentStub = async () => fakeResponse(null, 401);
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: false;
                reason: string;
                message: string;
            };
            assert.equal(result.reason, "http-error");
            assert.equal(result.message, "HTTP 401");
        });

        it("returns timeout when the request is aborted", async () => {
            currentStub = async () => {
                throw new TimeoutError();
            };
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: false;
                reason: string;
            };
            assert.equal(result.reason, "timeout");
        });

        it("returns http-error on network failure", async () => {
            currentStub = async () => {
                throw new Error("ECONNREFUSED");
            };
            const result = (await invoke({
                baseUrl: "https://x",
                api: "chatcomplete",
                apiKey: "k",
            })) as {
                ok: false;
                reason: string;
            };
            assert.equal(result.reason, "http-error");
        });

        it("appends /models to a baseUrl with no trailing slash", async () => {
            let captured = "";
            currentStub = async (url) => {
                captured = url;
                return fakeResponse({ data: [] });
            };
            await invoke({
                baseUrl: "https://api.example.com/v1",
                api: "chatcomplete",
                apiKey: "k",
            });
            assert.equal(captured, "https://api.example.com/v1/models");
        });

        it("strips a trailing slash before appending /models", async () => {
            let captured = "";
            currentStub = async (url) => {
                captured = url;
                return fakeResponse({ data: [] });
            };
            await invoke({
                baseUrl: "https://api.example.com/v1/",
                api: "chatcomplete",
                apiKey: "k",
            });
            assert.equal(captured, "https://api.example.com/v1/models");
        });
    });

    describe("provider.listModels saved branch ({providerId})", () => {
        function fakeServer(endpoint?: { baseUrl: string; api: string }, key?: string) {
            return {
                getProviderEndpoint: () => endpoint,
                providerKeyStore: { get: () => key },
            };
        }

        it("resolves baseUrl/api from the server and the key from the store", async () => {
            let capturedUrl = "";
            let capturedKey = "";
            currentStub = async (url, apiKey) => {
                capturedUrl = url;
                capturedKey = apiKey;
                return fakeResponse({ data: [{ id: "m-1" }] });
            };
            const result = (await invoke(
                { providerId: "deepseek" },
                fakeServer(
                    { baseUrl: "https://api.deepseek.com", api: "chatcomplete" },
                    "sk-stored",
                ),
            )) as { ok: true; models: string[] };
            assert.equal(result.ok, true);
            assert.equal(capturedUrl, "https://api.deepseek.com/models");
            assert.equal(capturedKey, "sk-stored");
            assert.deepEqual(result.models, ["m-1"]);
        });

        it("rejects an unknown provider id with invalid_params", async () => {
            await assert.rejects(
                () => invoke({ providerId: "nope" }, fakeServer(undefined, "k")),
                /unknown provider/,
            );
        });

        it("rejects when no key is configured for the provider", async () => {
            await assert.rejects(
                () =>
                    invoke(
                        { providerId: "deepseek" },
                        fakeServer({ baseUrl: "https://api.deepseek.com", api: "chatcomplete" }),
                    ),
                /no API key/,
            );
        });

        it("rejects an empty providerId", async () => {
            await assert.rejects(() => invoke({ providerId: " " }, fakeServer()), /providerId/);
        });
    });

    describe("extractModelIds (schema tolerance)", () => {
        it("returns null for non-object, non-array bodies", () => {
            assert.equal(extractModelIds("hello"), null);
            assert.equal(extractModelIds(42), null);
            assert.equal(extractModelIds(null), null);
        });
    });

    describe("performModelsRequest (outbound HTTP builder)", () => {
        // The outbound builder used to ship no User-Agent at all, leaving the
        // request identifiable only by Node's default (`User-Agent: node`).
        // These tests pin the taco identification on every /v1/models probe.
        it("sends user-agent and x-taco-sidecar-version matching the sidecar version", async () => {
            const version = sidecarVersion();
            let captured: RequestInit | undefined;
            const restore = mock.method(
                globalThis,
                "fetch",
                async (_url: unknown, init?: RequestInit) => {
                    captured = init;
                    return new Response(JSON.stringify({ data: [] }), { status: 200 });
                },
            );

            try {
                await performModelsRequest(
                    "https://example.com/v1/models",
                    "sk-test",
                    "chatcomplete",
                    AbortSignal.timeout(1000),
                );
                assert.ok(captured, "fetch should have been called");
                const headers = captured.headers as Record<string, string>;
                assert.equal(headers["user-agent"], `taco/${version}`);
                assert.equal(headers["x-taco-sidecar-version"], version);
                assert.equal(headers.Authorization, "Bearer sk-test");
            } finally {
                restore.mock.restore();
            }
        });

        it("sends x-api-key + anthropic-version instead of Bearer for api=anthropic", async () => {
            let captured: RequestInit | undefined;
            const restore = mock.method(
                globalThis,
                "fetch",
                async (_url: unknown, init?: RequestInit) => {
                    captured = init;
                    return new Response(JSON.stringify({ data: [] }), { status: 200 });
                },
            );

            try {
                await performModelsRequest(
                    "https://api.anthropic.com/v1/models",
                    "sk-ant-test",
                    "anthropic",
                    AbortSignal.timeout(1000),
                );
                const headers = captured?.headers as Record<string, string>;
                assert.equal(headers["x-api-key"], "sk-ant-test");
                assert.equal(headers["anthropic-version"], "2023-06-01");
                assert.equal(headers.Authorization, undefined);
            } finally {
                restore.mock.restore();
            }
        });
    });
});

describe("provider.testConnection", () => {
    /**
     * provider.testConnection handler — param resolution, result shaping, and the
     * error-reason classifier. The network probe is injected through deps, so
     * no request leaves the process; `performProbe` itself is exercised against a
     * local HTTP stub at the bottom.
     *
     * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/provider.testConnection.test.ts
     */

    interface ProbeCall {
        providerId: string;
        modelId: string;
        api: string;
        baseUrl: string;
        apiKey: string | undefined;
    }

    let calls: ProbeCall[] = [];
    let nextReply: (model: Model<Api>) => AssistantMessage | Promise<AssistantMessage>;

    function message(model: Model<Api>, over: Partial<AssistantMessage> = {}): AssistantMessage {
        return {
            role: "assistant",
            content: [{ type: "text", text: "pong" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 5,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 6,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
            ...over,
        } as AssistantMessage;
    }

    const savedProvider = buildCustomProvider({
        id: "custom:relay",
        name: "Relay",
        api: "response",
        baseUrl: "https://relay.example/v1",
        models: [{ id: "gpt-x" }],
    });

    function makeServer(keys: Record<string, string> = { "custom:relay": "sk-stored" }) {
        return {
            providerKeyStore: new ProviderKeyStore(keys),
            buildProvider: (id: string): Provider | undefined =>
                id === "custom:relay" ? savedProvider : undefined,
        };
    }

    async function invoke(params: unknown, server: unknown = makeServer()) {
        return callMethod("provider.testConnection", { server, params });
    }

    before(() => {
        registerBuiltinMethods();
    });

    beforeEach(() => {
        calls = [];
        nextReply = (model) => message(model);
        const probe: ProbeFn = async (provider, model, apiKey) => {
            calls.push({
                providerId: provider.id,
                modelId: model.id,
                api: model.api,
                baseUrl: model.baseUrl,
                apiKey,
            });
            return nextReply(model);
        };
        registerProviderTestHandlers({ probe });
    });

    describe("provider.testConnection — saved provider", () => {
        it("probes with the stored key and reports latency, model and reply", async () => {
            const result = (await invoke({ providerId: "custom:relay", modelId: "gpt-x" })) as {
                ok: true;
                latencyMs: number;
                model: string;
                reply: string;
            };
            assert.equal(result.ok, true);
            assert.equal(result.model, "gpt-x");
            assert.equal(result.reply, "pong");
            assert.ok(result.latencyMs >= 0);
            assert.deepEqual(calls, [
                {
                    providerId: "custom:relay",
                    modelId: "gpt-x",
                    api: "openai-responses",
                    baseUrl: "https://relay.example/v1",
                    apiKey: "sk-stored",
                },
            ]);
        });

        it("lets a typed-but-unsaved apiKey override the stored one", async () => {
            await invoke({ providerId: "custom:relay", modelId: "gpt-x", apiKey: "  sk-typed  " });
            assert.equal(calls[0]?.apiKey, "sk-typed");
        });

        it("probes a model id missing from the list using the provider's protocol", async () => {
            await invoke({ providerId: "custom:relay", modelId: "not-added-yet" });
            assert.equal(calls[0]?.modelId, "not-added-yet");
            assert.equal(calls[0]?.api, "openai-responses", "inherits the first model's protocol");
        });

        it("echoes the upstream responseModel when one is reported", async () => {
            nextReply = (model) => message(model, { responseModel: "gpt-x-2026-01" });
            const result = (await invoke({ providerId: "custom:relay", modelId: "gpt-x" })) as {
                model: string;
            };
            assert.equal(result.model, "gpt-x-2026-01");
        });

        it("rejects an unknown provider, a missing key, and a missing modelId as invalid params", async () => {
            await assert.rejects(
                () => invoke({ providerId: "custom:nope", modelId: "m" }),
                /unknown provider/,
            );
            await assert.rejects(
                () => invoke({ providerId: "custom:relay", modelId: "m" }, makeServer({})),
                /no API key configured/,
            );
            await assert.rejects(
                () => invoke({ providerId: "custom:relay", modelId: " " }),
                /modelId is required/,
            );
            assert.equal(calls.length, 0, "nothing reached the network");
        });
    });

    describe("provider.testConnection — create-custom form", () => {
        it("builds a throwaway provider from the form values", async () => {
            const result = (await invoke({
                baseUrl: " https://new.example/v1 ",
                api: "anthropic",
                apiKey: "sk-form",
                modelId: "claude-x",
            })) as { ok: boolean };
            assert.equal(result.ok, true);
            assert.deepEqual(calls[0], {
                providerId: "custom:connection-test",
                modelId: "claude-x",
                api: "anthropic-messages",
                baseUrl: "https://new.example/v1",
                apiKey: "sk-form",
            });
        });

        it("rejects an unsupported api and a blank key", async () => {
            await assert.rejects(
                () => invoke({ baseUrl: "https://x", api: "bogus", apiKey: "k", modelId: "m" }),
                /unsupported api/,
            );
            await assert.rejects(
                () =>
                    invoke({ baseUrl: "https://x", api: "chatcomplete", apiKey: "", modelId: "m" }),
                /apiKey is required/,
            );
        });
    });

    describe("provider.testConnection — failures", () => {
        it("maps an error message to a reason and keeps the text", async () => {
            nextReply = (model) =>
                message(model, {
                    stopReason: "error",
                    errorMessage: "401: invalid api key",
                    content: [],
                });
            const result = (await invoke({ providerId: "custom:relay", modelId: "gpt-x" })) as {
                ok: false;
                reason: string;
                message: string;
            };
            assert.equal(result.ok, false);
            assert.equal(result.reason, "auth");
            assert.equal(result.message, "401: invalid api key");
        });

        it("reports an aborted message as a timeout", async () => {
            nextReply = (model) => message(model, { stopReason: "aborted", content: [] });
            const result = (await invoke({ providerId: "custom:relay", modelId: "gpt-x" })) as {
                reason: string;
            };
            assert.equal(result.reason, "timeout");
        });

        it("turns a thrown probe into a failure result instead of an RPC error", async () => {
            nextReply = () => {
                const e = new Error("The operation was aborted due to timeout");
                e.name = "TimeoutError";
                throw e;
            };
            const result = (await invoke({ providerId: "custom:relay", modelId: "gpt-x" })) as {
                ok: false;
                reason: string;
            };
            assert.equal(result.ok, false);
            assert.equal(result.reason, "timeout");
        });

        it("truncates a long upstream error", async () => {
            nextReply = (model) =>
                message(model, {
                    stopReason: "error",
                    errorMessage: "x".repeat(1000),
                    content: [],
                });
            const result = (await invoke({ providerId: "custom:relay", modelId: "gpt-x" })) as {
                message: string;
            };
            assert.ok(result.message.length <= 301);
        });
    });

    describe("classifyMessage", () => {
        const cases: Array<[string, string]> = [
            ["401: Unauthorized", "auth"],
            ["403 Forbidden: permission denied", "auth"],
            ["Incorrect API key provided", "auth"],
            ["404: model not found", "not-found"],
            ["The model `foo` does not exist", "not-found"],
            ["429: rate limit exceeded", "rate-limited"],
            ["You exceeded your current quota", "rate-limited"],
            ["Request timed out", "timeout"],
            ["fetch failed: getaddrinfo ENOTFOUND relay.example", "network"],
            ["connect ECONNREFUSED 127.0.0.1:1", "network"],
            ["500: upstream exploded", "error"],
        ];
        for (const [text, reason] of cases) {
            it(`${JSON.stringify(text)} → ${reason}`, () => {
                assert.equal(classifyMessage(text), reason);
            });
        }
    });

    describe("performProbe — real pi streaming path against a local stub", () => {
        async function withStub(
            status: number,
            run: (
                baseUrl: string,
                seen: { auth?: string; path?: string; max?: number },
            ) => Promise<void>,
        ) {
            const seen: { auth?: string; path?: string; max?: number } = {};
            const srv = createServer((req, res) => {
                let body = "";
                req.on("data", (c) => {
                    body += c;
                });
                req.on("end", () => {
                    seen.auth = req.headers.authorization;
                    seen.path = req.url;
                    // pi's chat-completions adapter sends the newer field name.
                    const parsed = JSON.parse(body) as {
                        max_tokens?: number;
                        max_completion_tokens?: number;
                    };
                    seen.max = parsed.max_completion_tokens ?? parsed.max_tokens;
                    if (status !== 200) {
                        res.writeHead(status, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: { message: `stub ${status}` } }));
                        return;
                    }
                    res.writeHead(200, { "content-type": "text/event-stream" });
                    const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
                    send({
                        id: "1",
                        object: "chat.completion.chunk",
                        model: "echo-1",
                        choices: [
                            {
                                index: 0,
                                delta: { role: "assistant", content: "pong" },
                                finish_reason: null,
                            },
                        ],
                    });
                    send({
                        id: "1",
                        object: "chat.completion.chunk",
                        model: "echo-1",
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    });
                    res.end("data: [DONE]\n\n");
                });
            });
            await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
            const { port } = srv.address() as AddressInfo;
            try {
                await run(`http://127.0.0.1:${port}/v1`, seen);
            } finally {
                // Awaited: close() stops accepting but resolves only once open
                // connections drain, so an un-awaited close leaks a handle into
                // the rest of the run.
                srv.closeAllConnections();
                await new Promise<void>((r) => srv.close(() => r()));
            }
        }

        function stubProvider(baseUrl: string) {
            const p = buildCustomProvider({
                id: "custom:stub",
                name: "Stub",
                api: "chatcomplete",
                baseUrl,
                models: [{ id: "echo-1" }],
            });
            const model = p.getModels()[0];
            assert.ok(model);
            return { p, model };
        }

        it("sends a capped chat request with the key and returns the reply", async () => {
            await withStub(200, async (baseUrl, seen) => {
                const { p, model } = stubProvider(baseUrl);
                const m = await performProbe(p, model, "sk-probe", AbortSignal.timeout(5000));
                assert.equal(m.stopReason, "stop");
                assert.equal(seen.path, "/v1/chat/completions");
                assert.equal(seen.auth, "Bearer sk-probe");
                assert.equal(seen.max, 16);
            });
        });

        it("surfaces an upstream 401 on the message, classified as auth", async () => {
            await withStub(401, async (baseUrl) => {
                const { p, model } = stubProvider(baseUrl);
                const m = await performProbe(p, model, "sk-bad", AbortSignal.timeout(5000));
                assert.equal(m.stopReason, "error");
                assert.equal(classifyMessage(m.errorMessage ?? ""), "auth");
            });
        });
    });
});
