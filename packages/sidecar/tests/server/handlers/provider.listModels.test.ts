/**
 * provider.listModels handler — invokes the registered top-level RPC and
 * asserts the schema-tolerance / protocol-branch / error-reason logic.
 *
 * Network is stubbed by re-registering the handler with a fake
 * `performModelsRequest` injected through deps; fetch is never called.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/provider.listModels.test.ts
 */

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it } from "node:test";
import {
    extractModelIds,
    type performModelsRequest as RealPerform,
    registerProviderModelsHandlers,
    TimeoutError,
} from "../../../src/server/handlers/providerModels.ts";
import { getRegisteredMethod } from "../../../src/server/methodRegistry.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";

type Stub = (url: string, apiKey: string, signal: AbortSignal) => Promise<FakeResponse>;

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
        performModelsRequest: ((url: string, apiKey: string, signal: AbortSignal) => {
            const stub = currentStub;
            if (!stub) throw new Error("test forgot to set currentStub");
            return stub(url, apiKey, signal);
        }) as unknown as typeof RealPerform,
    });
});

function makeCtx(
    params: unknown,
): Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0] {
    return {
        id: "test-id",
        workspace: undefined as never,
        cwd: "*",
        server: {} as never,
        params,
    } as unknown as Parameters<NonNullable<ReturnType<typeof getRegisteredMethod>>["handler"]>[0];
}

async function invoke(params: unknown): Promise<unknown> {
    const reg = getRegisteredMethod("provider.listModels");
    assert.ok(reg, "provider.listModels must be registered");
    return reg.handler(makeCtx(params));
}

describe("provider.listModels handler", () => {
    it("returns protocol-not-supported for api=response", async () => {
        const result = (await invoke({ baseUrl: "https://x", api: "response", apiKey: "k" })) as {
            ok: false;
            reason: string;
            message: string;
        };
        assert.equal(result.ok, false);
        assert.equal(result.reason, "protocol-not-supported");
        assert.match(result.message, /Responses/);
    });

    it("returns protocol-not-supported for api=anthropic with a friendly message", async () => {
        const result = (await invoke({ baseUrl: "https://x", api: "anthropic", apiKey: "k" })) as {
            ok: false;
            reason: string;
            message: string;
        };
        assert.equal(result.reason, "protocol-not-supported");
        assert.match(result.message, /Anthropic/);
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

describe("extractModelIds (schema tolerance)", () => {
    it("returns null for non-object, non-array bodies", () => {
        assert.equal(extractModelIds("hello"), null);
        assert.equal(extractModelIds(42), null);
        assert.equal(extractModelIds(null), null);
    });
});
