import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ImRoute } from "@taco-ai/protocol";
import { classifySendError } from "../../src/channels/builtin/sendErrors.ts";
import { ChannelRegistry } from "../../src/channels/registry.ts";
import type { Channel, ChannelHandle, SendOutboundResult } from "../../src/channels/types.ts";

const route: ImRoute = { channelId: "c1", peerId: "p1", chatId: "p1" };

function err(shape: Record<string, unknown>, message = "boom"): Error {
    return Object.assign(new Error(message), shape);
}

describe("classifySendError", () => {
    it("treats a missing WeChat context token as permanent", () => {
        assert.deepEqual(classifySendError(err({ name: "NoContextError" })), {
            kind: "permanentFailure",
            code: "no_context",
        });
        assert.equal(classifySendError(err({ code: "NO_CONTEXT" })).kind, "permanentFailure");
    });

    it("treats an expired WeChat bot session as unavailable, not as a bad target", () => {
        assert.deepEqual(classifySendError(err({ errcode: -14 })), {
            kind: "unavailable",
            code: "session_expired",
        });
    });

    it("retries rate limits and server errors", () => {
        assert.equal(classifySendError(err({ httpStatus: 429 })).kind, "retryable");
        assert.equal(classifySendError(err({ httpStatus: 503 })).kind, "retryable");
    });

    it("waits for re-auth on 401/403 instead of burning attempts", () => {
        assert.equal(classifySendError(err({ httpStatus: 401 })).kind, "unavailable");
        assert.equal(classifySendError(err({ httpStatus: 403 })).kind, "unavailable");
        assert.equal(classifySendError(err({ name: "AuthError" })).kind, "unavailable");
    });

    it("treats other 4xx as permanent", () => {
        assert.deepEqual(classifySendError(err({ httpStatus: 400 })), {
            kind: "permanentFailure",
            code: "http_400",
        });
    });

    it("retries transient network failures", () => {
        assert.deepEqual(classifySendError(err({ code: "ECONNRESET" })), {
            kind: "retryable",
            code: "econnreset",
        });
        assert.equal(classifySendError(err({ name: "TransportError" })).kind, "retryable");
    });

    it("reads WeCom's plain-Error messages", () => {
        assert.equal(classifySendError(new Error("WebSocket not connected")).kind, "unavailable");
        assert.equal(classifySendError(new Error("ack timed out")).kind, "retryable");
    });

    it("defaults to retryable so an unknown failure never loses the message", () => {
        assert.equal(classifySendError(new Error("???")).kind, "retryable");
        assert.equal(classifySendError("a string").kind, "retryable");
        assert.equal(classifySendError(undefined).kind, "retryable");
    });

    it("never puts the platform's message text into the code", () => {
        const result = classifySendError(new Error("token=secret-value rejected"));
        assert.ok(result.kind !== "confirmed");
        assert.ok(!result.code.includes("secret"));
    });
});

describe("ChannelRegistry.sendText", () => {
    function register(
        registry: ChannelRegistry,
        handle: Partial<ChannelHandle>,
        maxMessageLength = 100,
    ): void {
        registry.register(
            "c1",
            {
                manifest: { name: "fake", version: "1", capabilities: { maxMessageLength } },
                start: async () => handle as ChannelHandle,
            } as unknown as Channel,
            { push: async () => undefined, close: async () => undefined, ...handle },
        );
    }

    it("is unavailable for a channel that is not loaded", async () => {
        const registry = new ChannelRegistry();
        assert.deepEqual(await registry.sendText("nope", route, "x"), {
            kind: "unavailable",
            code: "channel_unavailable",
        });
    });

    it("is unavailable for a channel with no outbound path", async () => {
        const registry = new ChannelRegistry();
        register(registry, {});
        assert.equal((await registry.sendText("c1", route, "x")).kind, "unavailable");
    });

    it("passes the handle's result through", async () => {
        const registry = new ChannelRegistry();
        const seen: string[] = [];
        register(registry, {
            sendText: async (_r, text) => {
                seen.push(text);
                return { kind: "confirmed" };
            },
        });
        assert.deepEqual(await registry.sendText("c1", route, "hello"), { kind: "confirmed" });
        assert.deepEqual(seen, ["hello"]);
    });

    it("turns a throwing handle into a retryable result", async () => {
        const registry = new ChannelRegistry();
        register(registry, {
            sendText: async () => {
                throw new Error("kaboom");
            },
        });
        assert.deepEqual(await registry.sendText("c1", route, "x"), {
            kind: "retryable",
            code: "send_threw",
        });
    });

    it("keeps working after a throw", async () => {
        const registry = new ChannelRegistry();
        let calls = 0;
        register(registry, {
            sendText: async () => {
                calls++;
                if (calls === 1) throw new Error("first fails");
                return { kind: "confirmed" };
            },
        });
        await registry.sendText("c1", route, "a");
        assert.equal((await registry.sendText("c1", route, "b")).kind, "confirmed");
    });

    it("serializes sends and streaming pushes on the channel's chain", async () => {
        const registry = new ChannelRegistry();
        const order: string[] = [];
        let releasePush: () => void = () => undefined;
        register(registry, {
            push: async () => {
                order.push("push:start");
                await new Promise<void>((resolve) => {
                    releasePush = resolve;
                });
                order.push("push:end");
            },
            sendText: async (): Promise<SendOutboundResult> => {
                order.push("send");
                return { kind: "confirmed" };
            },
        });

        registry.push("c1", { method: "x" } as never);
        const sending = registry.sendText("c1", route, "notice");
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(order, ["push:start"]);

        releasePush();
        await sending;
        assert.deepEqual(order, ["push:start", "push:end", "send"]);
    });

    it("reports the channel's message cap, or undefined when not loaded", () => {
        const registry = new ChannelRegistry();
        register(registry, {}, 321);
        assert.equal(registry.maxMessageLength("c1"), 321);
        assert.equal(registry.maxMessageLength("nope"), undefined);
    });
});
