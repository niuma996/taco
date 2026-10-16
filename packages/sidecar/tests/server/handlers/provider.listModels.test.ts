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

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it, mock } from "node:test";
import { sidecarVersion } from "../../../src/runtime/runtimeResources.ts";
import {
    extractModelIds,
    performModelsRequest,
    type performModelsRequest as RealPerform,
    registerProviderModelsHandlers,
    TimeoutError,
} from "../../../src/server/handlers/providerModels.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";

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
        performModelsRequest: ((url: string, apiKey: string, api: string, signal: AbortSignal) => {
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
        currentStub = async () => fakeResponse({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
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
        await invoke({ baseUrl: "https://api.example.com/v1", api: "chatcomplete", apiKey: "k" });
        assert.equal(captured, "https://api.example.com/v1/models");
    });

    it("strips a trailing slash before appending /models", async () => {
        let captured = "";
        currentStub = async (url) => {
            captured = url;
            return fakeResponse({ data: [] });
        };
        await invoke({ baseUrl: "https://api.example.com/v1/", api: "chatcomplete", apiKey: "k" });
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
            fakeServer({ baseUrl: "https://api.deepseek.com", api: "chatcomplete" }, "sk-stored"),
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
