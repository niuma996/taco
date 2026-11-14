import { type ChannelsListConversationsResult, makeImCwd } from "@taco-ai/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationsPane } from "../../src/hooks/useConversationsPane";
import { conversationActivityKey } from "../../src/lib/chat/conversationActivity";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { type DesktopConfig, writeDesktopConfig } from "../../src/lib/desktopConfig";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let disk: DesktopConfig;
beforeEach(() => {
    disk = {};
    invoke.mockReset();
    invoke.mockImplementation(async (command: string, args?: { contents: string }) => {
        if (command === "desktop_config_read") return JSON.stringify(disk);
        if (command === "desktop_config_write" && args) disk = JSON.parse(args.contents);
    });
});

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
interface PaneProps {
    active: boolean;
    cwd?: string;
    transportCwd?: string;
}
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
    const view = renderHook(
        ({ active, cwd = "/repo", transportCwd }: PaneProps) =>
            useConversationsPane(client, active, cwd, transportCwd),
        { initialProps: { active: initialActive } as PaneProps },
    );
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

const cwd = makeImCwd("wecom", "team", "support");
const key = conversationActivityKey({ workspace: cwd, sessionId: "s1" });
function traffic(lastUsedAt = 2, sessionId = "s1"): ChannelsListConversationsResult {
    return { conversations: [{ ...listed.conversations[0], lastUsedAt, sessionId }] };
}
async function refresh(h: ReturnType<typeof setup>) {
    await act(async () => {
        await h.result.current.refreshConversations();
    });
}
async function hide(h: ReturnType<typeof setup>) {
    await act(async () => {
        await h.result.current.hideConversation(cwd);
    });
}

describe("persistent IM hiding", () => {
    it("persists the inbound baseline and keeps the same route hidden after remount", async () => {
        const h = setup();
        await act(async () => {});
        await hide(h);
        expect(h.result.current.conversations).toEqual([]);
        expect(disk.hiddenConversations).toEqual({ [cwd]: { sessionId: "s1", lastUsedAt: 1 } });
        h.unmount();
        const restarted = setup();
        await act(async () => {});
        expect(restarted.result.current.conversations).toEqual([]);
        expect(restarted.result.current.restoredUnread).toEqual({});
    });

    it("ignores rename, transcript timestamps, older activity, and temporary absence", async () => {
        const h = setup();
        await act(async () => {});
        await hide(h);
        h.channelsListConversations.mockResolvedValueOnce({ conversations: [] });
        await refresh(h);
        for (const lastUsedAt of [0, 1]) {
            h.channelsListConversations.mockResolvedValueOnce({
                conversations: [
                    {
                        ...listed.conversations[0],
                        lastUsedAt,
                        name: "Renamed",
                        updatedAt: "2099-01-01",
                    },
                ],
            });
            await refresh(h);
            expect(h.result.current.conversations).toEqual([]);
        }
        expect(disk.hiddenConversations?.[cwd]).toEqual({ sessionId: "s1", lastUsedAt: 1 });
    });

    it.each([traffic(), traffic(0, "s2")])(
        "restores only the matching route for inbound activity %j",
        async (next) => {
            const h = setup();
            await act(async () => {});
            await hide(h);
            h.channelsListConversations.mockResolvedValue(next);
            await refresh(h);
            const restoredKey = conversationActivityKey({
                workspace: cwd,
                sessionId: next.conversations[0].sessionId,
            });
            expect(h.result.current.conversations).toEqual(next.conversations);
            expect(h.result.current.restoredUnread).toEqual({ [restoredKey]: true });
            expect(h.result.current.unreadCount).toBe(1);
            expect(disk.hiddenConversations?.[cwd]).toBeUndefined();
            h.unmount();
            const restarted = setup({ channelsListConversations: vi.fn().mockResolvedValue(next) });
            await act(async () => {});
            expect(restarted.result.current.restoredUnread).toEqual({});
        },
    );

    it("restores inbound traffic received while the application was stopped", async () => {
        const h = setup();
        await act(async () => {});
        await hide(h);
        h.unmount();
        const restarted = setup({
            channelsListConversations: vi.fn().mockResolvedValue(traffic()),
        });
        await act(async () => {});
        expect(restarted.result.current.restoredUnread).toEqual({ [key]: true });
        expect(restarted.result.current.unreadCount).toBe(1);
    });

    it("does not clear restored unread for selection in another pane; explicit reading clears it", async () => {
        const h = setup();
        await act(async () => {});
        await hide(h);
        h.rerender({ active: false, cwd });
        h.channelsListConversations.mockResolvedValue(traffic());
        await refresh(h);
        expect(h.result.current.restoredUnread).toEqual({ [key]: true });
        await act(async () => {
            h.result.current.markConversationRead(cwd);
        });
        expect(h.result.current.restoredUnread).toEqual({});
        await refresh(h);
        expect(h.result.current.restoredUnread).toEqual({});
    });

    it("continues refreshing with the last transport workspace after all workspaces are removed", async () => {
        const h = setup();
        await act(async () => {});
        await hide(h);
        h.rerender({ active: false, cwd: "" });
        h.channelsListConversations.mockResolvedValue(traffic());
        await act(async () => {
            h.result.current.onConversationsChanged();
        });
        expect(h.result.current.conversations).toEqual(traffic().conversations);
        expect(h.start).toHaveBeenLastCalledWith("/repo");
        expect(h.result.current.restoredUnread).toEqual({ [key]: true });
    });

    it("discovers IM after cold startup with an explicitly empty workspace list", async () => {
        const start = vi.fn(async () => {});
        const list = vi.fn(async () => listed);
        const client = {
            start,
            channelsListConversations: list,
            onConnectionReady: () => () => {},
        } as unknown as TacoClient;
        const h = renderHook(
            ({ transportCwd }: { transportCwd?: string }) =>
                useConversationsPane(client, false, "", transportCwd),
            { initialProps: {} },
        );
        await act(async () => {});
        expect(list).not.toHaveBeenCalled();
        h.rerender({ transportCwd: "/default" });
        await act(async () => {});
        expect(start).toHaveBeenLastCalledWith("/default");
        expect(h.result.current.conversations).toEqual(listed.conversations);
        expect(disk.workspaces).toBeUndefined();
    });

    it("only hides after a successful save, and rejects write failures", async () => {
        const h = setup();
        await act(async () => {});
        const saved = deferred<void>();
        invoke.mockImplementationOnce(async () => JSON.stringify(disk));
        invoke.mockImplementationOnce(() => saved.promise);
        let hiding!: Promise<void>;
        await act(async () => {
            hiding = h.result.current.hideConversation(cwd);
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
        const rejected = expect(hiding).rejects.toThrow("disk full");
        await act(async () => {
            saved.reject(new Error("disk full"));
            await rejected;
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
    });

    it("invalidates a list already in flight when hide starts", async () => {
        const h = setup();
        await act(async () => {});
        const old = deferred<ChannelsListConversationsResult>();
        h.channelsListConversations.mockReturnValueOnce(old.promise);
        let loading!: Promise<void>;
        await act(async () => {
            loading = h.result.current.refreshConversations();
        });
        await hide(h);
        await act(async () => {
            old.resolve(traffic());
            await loading;
        });
        expect(h.result.current.conversations).toEqual([]);
        expect(h.result.current.restoredUnread).toEqual({});
        expect(h.result.current.loading).toBe(false);
    });

    it("retains newer inbound metadata arriving while the hide save is pending", async () => {
        const h = setup();
        await act(async () => {});
        const saved = deferred<void>();
        invoke.mockImplementationOnce(async () => JSON.stringify(disk));
        invoke.mockImplementationOnce(async (_command: string, args: { contents: string }) => {
            await saved.promise;
            disk = JSON.parse(args.contents);
        });
        let hiding!: Promise<void>;
        await act(async () => {
            hiding = h.result.current.hideConversation(cwd);
        });
        h.channelsListConversations.mockResolvedValue(traffic());
        await refresh(h);
        expect(h.result.current.conversations).toEqual(traffic().conversations);
        await act(async () => {
            saved.resolve();
            await hiding;
        });
        expect(h.result.current.conversations).toEqual(traffic().conversations);
        expect(h.result.current.restoredUnread).toEqual({ [key]: true });
    });

    it("does not re-mark traffic read while the original hide save was pending", async () => {
        const h = setup();
        await act(async () => {});
        const saved = deferred<void>();
        invoke.mockImplementationOnce(async () => JSON.stringify(disk));
        invoke.mockImplementationOnce(async (_command: string, args: { contents: string }) => {
            await saved.promise;
            disk = JSON.parse(args.contents);
        });
        let hiding!: Promise<void>;
        await act(async () => {
            hiding = h.result.current.hideConversation(cwd);
        });
        h.channelsListConversations.mockResolvedValue(traffic());
        await refresh(h);
        await act(async () => {
            h.result.current.markConversationRead(cwd);
        });
        await act(async () => {
            saved.resolve();
            await hiding;
        });
        expect(h.result.current.restoredUnread).toEqual({});
    });

    it("does not let delayed restore persistence overwrite a newer list or read acknowledgement", async () => {
        const h = setup();
        await act(async () => {});
        await hide(h);
        const saved = deferred<void>();
        invoke.mockImplementationOnce(async () => JSON.stringify(disk));
        invoke.mockImplementationOnce(async (_command: string, args: { contents: string }) => {
            await saved.promise;
            disk = JSON.parse(args.contents);
        });
        h.channelsListConversations.mockResolvedValueOnce(traffic());
        let restoring!: Promise<void>;
        await act(async () => {
            restoring = h.result.current.refreshConversations();
        });
        h.channelsListConversations.mockResolvedValue(traffic(3));
        await refresh(h);
        await act(async () => {
            h.result.current.markConversationRead(cwd);
        });
        await act(async () => {
            saved.resolve();
            await restoring;
        });
        expect(h.result.current.conversations).toEqual(traffic(3).conversations);
        expect(h.result.current.restoredUnread).toEqual({});
    });

    it("keeps other hidden routes intact during concurrent hides and restores", async () => {
        const other = { ...listed.conversations[0], chatId: "other", sessionId: "other-session" };
        const otherCwd = makeImCwd(other.channelId, other.peerId, other.chatId);
        const list = vi.fn().mockResolvedValue({ conversations: [...listed.conversations, other] });
        const h = setup({ channelsListConversations: list });
        await act(async () => {});
        await act(async () => {
            await Promise.all([
                h.result.current.hideConversation(cwd),
                h.result.current.hideConversation(otherCwd),
            ]);
        });
        expect(h.result.current.conversations).toEqual([]);
        list.mockResolvedValue({ conversations: [...traffic().conversations, other] });
        await refresh(h);
        expect(h.result.current.conversations).toEqual(traffic().conversations);
        expect(disk.hiddenConversations).toEqual({
            [otherCwd]: { sessionId: "other-session", lastUsedAt: 1 },
        });
    });

    it("surfaces initial hidden-config read errors and reloads persisted hides on retry", async () => {
        disk = { hiddenConversations: { [cwd]: { sessionId: "s1", lastUsedAt: 1 } } };
        invoke.mockRejectedValueOnce(new Error("config unavailable"));
        const h = setup();
        await act(async () => {});
        expect(h.result.current.error).toBe("config unavailable");
        expect(h.result.current.conversations).toBeNull();
        expect(h.channelsListConversations).not.toHaveBeenCalled();
        await refresh(h);
        expect(h.result.current.conversations).toEqual([]);
        expect(h.result.current.error).toBeNull();
    });

    it("rejects config read failures without hiding or overwriting saved preferences", async () => {
        const h = setup();
        await act(async () => {});
        disk = { debugMode: true };
        invoke.mockRejectedValueOnce(new Error("read failed"));
        await act(async () => {
            await expect(h.result.current.hideConversation(cwd)).rejects.toThrow("read failed");
        });
        expect(h.result.current.conversations).toEqual(listed.conversations);
        expect(disk).toEqual({ debugMode: true });
        await hide(h);
        expect(disk.debugMode).toBe(true);
        expect(h.result.current.conversations).toEqual([]);
    });

    it("serializes config patches so concurrent preferences survive hiding", async () => {
        const h = setup();
        await act(async () => {});
        await act(async () => {
            await Promise.all([
                h.result.current.hideConversation(cwd),
                writeDesktopConfig({ workspaces: { opened: [], active: "", emptyAllowed: true } }),
                writeDesktopConfig({ debugMode: true }),
            ]);
        });
        expect(disk.hiddenConversations?.[cwd]).toEqual({ sessionId: "s1", lastUsedAt: 1 });
        expect(disk.workspaces).toEqual({ opened: [], active: "", emptyAllowed: true });
        expect(disk.debugMode).toBe(true);
    });
});
