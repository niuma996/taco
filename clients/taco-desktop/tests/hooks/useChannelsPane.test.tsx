import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useChannelsPane } from "../../src/hooks/useChannelsPane";

afterEach(cleanup);

it("installs, restarts, then replaces stale startup failures with the fresh list", async () => {
    const calls: string[] = [];
    let recovered = false;
    const client = {
        channelsList: vi.fn(async () => ({
            available: [],
            configured: [],
            failed: recovered ? [] : [{ channelId: "wechat", error: "SDK missing" }],
        })),
        channelsInstallSdk: vi.fn(async () => {
            calls.push("install");
        }),
    };
    const restart = vi.fn(async () => {
        calls.push("restart");
        recovered = true;
    });
    const { result } = renderHook(() => useChannelsPane(client as never, true, "/ws", restart));
    await waitFor(() => expect(result.current.channelsStatus?.failed).toHaveLength(1));
    await act(async () => result.current.installChannelSdk("wechat"));
    expect(calls).toEqual(["install", "restart"]);
    expect(client.channelsInstallSdk).toHaveBeenCalledWith({ channelId: "wechat" });
    expect(result.current.channelsStatus?.failed).toEqual([]);
    expect(result.current.channelsSavingId).toBeNull();
});

it("keeps the failure visible and does not restart when installation fails", async () => {
    const client = {
        channelsList: vi.fn(async () => ({
            available: [],
            configured: [],
            failed: [{ channelId: "wecom", error: "SDK missing" }],
        })),
        channelsInstallSdk: vi.fn(async () => {
            throw new Error("npm unavailable");
        }),
    };
    const restart = vi.fn(async () => {});
    const { result } = renderHook(() => useChannelsPane(client as never, true, "/ws", restart));
    await waitFor(() => expect(result.current.channelsStatus?.failed).toHaveLength(1));
    await act(async () => result.current.installChannelSdk("wecom"));
    expect(restart).not.toHaveBeenCalled();
    expect(result.current.channelsError).toBe("npm unavailable");
    expect(result.current.channelsStatus?.failed).toHaveLength(1);
});

it("blocks competing channel actions while installation is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const client = {
        channelsList: vi.fn(async () => ({ available: [], configured: [], failed: [] })),
        channelsInstallSdk: vi.fn(() => pending),
        channelsCreate: vi.fn(),
    };
    const restart = vi.fn(async () => {});
    const { result } = renderHook(() => useChannelsPane(client as never, true, "/ws", restart));
    await waitFor(() => expect(client.channelsList).toHaveBeenCalled());
    let install!: Promise<void>;
    act(() => {
        install = result.current.installChannelSdk("wechat");
    });
    await act(async () => {
        await result.current.createChannel("wecom");
        await result.current.restartForChannels();
        await result.current.installChannelSdk("wecom");
    });
    expect(client.channelsCreate).not.toHaveBeenCalled();
    expect(client.channelsInstallSdk).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
    expect(result.current.channelsInstallingId).toBe("wechat");
    await act(async () => {
        finish();
        await install;
    });
    expect(result.current.channelsInstallingId).toBeNull();
    expect(restart).toHaveBeenCalledTimes(1);
});
