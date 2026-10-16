/**
 * provider.testConnection handler — param resolution, result shaping, and the
 * error-reason classifier. The network probe is injected through deps, so
 * no request leaves the process; `performProbe` itself is exercised against a
 * local HTTP stub at the bottom.
 *
 * Run: cd packages/sidecar && pnpm exec tsx --test tests/server/handlers/provider.testConnection.test.ts
 */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { before, beforeEach, describe, it } from "node:test";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { buildCustomProvider } from "../../../src/runtime/models/customProvider.ts";
import { ProviderKeyStore } from "../../../src/runtime/models/providerKeyStore.ts";
import {
    classifyMessage,
    type ProbeFn,
    performProbe,
    registerProviderTestHandlers,
} from "../../../src/server/handlers/providerTest.ts";
import { registerBuiltinMethods } from "../../../src/server/methods.ts";
import { callMethod } from "../../_helpers/handlerCall.ts";

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
            () => invoke({ baseUrl: "https://x", api: "chatcomplete", apiKey: "", modelId: "m" }),
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
            message(model, { stopReason: "error", errorMessage: "x".repeat(1000), content: [] });
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
