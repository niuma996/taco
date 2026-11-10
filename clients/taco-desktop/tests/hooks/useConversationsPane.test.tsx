import type { ChannelsListConversationsResult } from "@taco-ai/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationsPane } from "../../src/hooks/useConversationsPane";
import type { TacoClient } from "../../src/lib/clients/tacoClient";

vi.mock("../../src/hooks/useSidecarStream", () => ({ sidecarLogListenerReady: Promise.resolve() }));

afterEach(cleanup);
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const listed: ChannelsListConversationsResult = {
    conversations: [
        {
            channelId: "wecom",
            peerId: "team",
            chatId: "support",
            sessionId: "s1",
            lastUsedAt: 1,
        },
    ],
};
function setup(overrides: Partial<TacoClient> = {}, initialActive = true) {
    let ready: () => void = () => {};
    const start = vi.fn(async () => {});
    const channelsListConversations = vi.fn(async () => listed);
    const client = {
        start,
        channelsListConversations,
        onConnectionReady: vi.fn((callback) => {
            ready = callback;
            return () => {};
        }),
        ...overrides,
    } as unknown as TacoClient;
    const view = renderHook(({ active }) => useConversationsPane(client, active, "/repo"), {
        initialProps: { active: initialActive },
    });
    return { ...view, start, channelsListConversations, ready: () => ready() };
}

describe("IM conversation loading", () => {
    it("waits for a started connection before sending a process-scoped request", async () => {
        const started = deferred<void>();
        const h = setup({ start: vi.fn(() => started.promise) });
        expect(h.channelsListConversations).not.toHaveBeenCalled();
        await act(async () => {
            started.resolve();
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
        expect(h.channelsListConversations).toHaveBeenCalledTimes(1);
    });

    it("drops an older failure after a retry has loaded the list", async () => {
        const old = deferred<ChannelsListConversationsResult>();
        const list = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(listed);
        const h = setup({ channelsListConversations: list });
        await act(async () => {});
        await act(async () => {
            await h.result.current.refreshConversations();
        });
        await act(async () => {
            old.reject(new Error("old connection"));
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
        expect(h.result.current.error).toBeNull();
    });

    it("retries after connection readiness and clears a previous failure", async () => {
        const list = vi
            .fn()
            .mockRejectedValueOnce(new Error("not started"))
            .mockResolvedValue(listed);
        const h = setup({ channelsListConversations: list });
        await act(async () => {});
        expect(h.result.current.error).toBe("not started");
        await act(async () => {
            h.ready();
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
        expect(h.result.current.error).toBeNull();
    });

    it("refreshes after returning to IM browsing without clearing the cached list", async () => {
        const h = setup();
        await act(async () => {});
        h.rerender({ active: false });
        const pending = deferred<ChannelsListConversationsResult>();
        h.channelsListConversations.mockReturnValueOnce(pending.promise);
        h.rerender({ active: true });
        await act(async () => {});
        expect(h.result.current.conversations).toEqual(listed.conversations);
        expect(h.result.current.loading).toBe(true);
        await act(async () => {
            pending.resolve({ conversations: [] });
        });
        expect(h.result.current.conversations).toEqual([]);
    });
    it("does not let a response from the previous connection erase the recovered list", async () => {
        const old = deferred<ChannelsListConversationsResult>();
        const list = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(listed);
        const h = setup({ channelsListConversations: list });
        await act(async () => {});
        await act(async () => {
            h.ready();
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
        await act(async () => {
            old.resolve({ conversations: [] });
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
    });
    it("seeds unread tracking while hidden so the first incoming message is counted", async () => {
        const list = vi
            .fn()
            .mockResolvedValueOnce(listed)
            .mockResolvedValue({ conversations: [{ ...listed.conversations[0], lastUsedAt: 2 }] });
        const h = setup({ channelsListConversations: list }, false);
        await act(async () => {});
        expect(h.result.current.unreadCount).toBe(0);
        await act(async () => {
            h.result.current.onConversationsChanged();
        });
        expect(h.result.current.unreadCount).toBe(1);
    });
});
