import { strict as assert } from "node:assert";
import type { ImPolicyGetResult, ImWorkspacePolicyPatch } from "@taco-ai/protocol";
import { act, renderHook } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { useImPolicy } from "../../src/hooks/useImPolicy";
import type { TacoClient } from "../../src/lib/tacoClientTauri.ts";

function makeClient(overrides: Partial<TacoClient> = {}): TacoClient {
    return {
        imPolicyGet: vi.fn(async () => {
            const result: ImPolicyGetResult = {
                channelId: "wechat",
                channelDefault: {},
                resolved: {
                    tools: { fsTools: "deny", shell: "deny" },
                    commands: { mode: "ask" },
                },
                chatOverride: null,
                hasOverride: false,
                overrides: [],
            };
            return result;
        }),
        imPolicySetChannelDefault: vi.fn(async () => ({ channelId: "wechat" })),
        imPolicySetChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
        imPolicyClearChatOverride: vi.fn(async () => ({ channelId: "wechat" })),
        ...overrides,
    } as unknown as TacoClient;
}

describe("useImPolicy", () => {
    it("load() populates data and clears loading", async () => {
        const client = makeClient();
        const { result } = renderHook(() => useImPolicy(client, null));

        await act(async () => {
            await result.current.load("wechat");
        });

        assert.equal(result.current.loading, false);
        assert.ok(result.current.data);
        assert.equal(result.current.data?.channelId, "wechat");
    });

    it("saveChannelDefault forwards the patch to imPolicySetChannelDefault", async () => {
        const client = makeClient();
        const { result } = renderHook(() => useImPolicy(client, null));

        const patch: ImWorkspacePolicyPatch = { tools: { shell: "allow" } };
        let ok = false;
        await act(async () => {
            ok = await result.current.saveChannelDefault("wechat", patch);
        });

        assert.equal(ok, true);
        assert.deepEqual(
            (client.imPolicySetChannelDefault as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
            { channelId: "wechat", patch },
        );
    });

    it("clearChatOverrideByKey forwards chatKey", async () => {
        const client = makeClient();
        const { result } = renderHook(() => useImPolicy(client, null));

        let ok = false;
        await act(async () => {
            ok = await result.current.clearChatOverrideByKey("wechat", "a".repeat(64));
        });

        assert.equal(ok, true);
        assert.deepEqual(
            (client.imPolicyClearChatOverride as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
            { channelId: "wechat", chatKey: "a".repeat(64) },
        );
    });

    it("onImPolicyChanged is a no-op when the channel doesn't match", () => {
        const client = makeClient();
        const { result } = renderHook(() =>
            useImPolicy(client, { channelId: "wechat", peerId: "u1", chatId: "c1" }),
        );
        result.current.onImPolicyChanged("feishu");
        assert.equal((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    });

    it("onImPolicyChanged reloads the channel in channel-scope mode after a prior load", async () => {
        const client = makeClient();
        const { result } = renderHook(() => useImPolicy(client, null));

        await act(async () => {
            await result.current.load("wechat");
        });
        assert.equal((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length, 1);

        await act(async () => {
            result.current.onImPolicyChanged("wechat");
            // Drain the load promise.
            await Promise.resolve();
        });
        assert.equal((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length, 2);
        assert.deepEqual((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls[1]?.[0], {
            channelId: "wechat",
            peerId: undefined,
            chatId: undefined,
        });
    });

    it("onImPolicyChanged is a no-op in channel-scope mode before any load", () => {
        const client = makeClient();
        const { result } = renderHook(() => useImPolicy(client, null));
        result.current.onImPolicyChanged("wechat");
        assert.equal((client.imPolicyGet as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    });

    it("a failing RPC surfaces in error", async () => {
        vi.useFakeTimers();
        try {
            const client = makeClient({
                imPolicyGet: vi.fn(async () => {
                    throw new Error("boom");
                }),
            });
            const { result } = renderHook(() => useImPolicy(client, null));

            await act(async () => {
                await result.current.load("wechat");
            });
            assert.equal(result.current.error, "boom");
        } finally {
            vi.useRealTimers();
        }
    });
});
