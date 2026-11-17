import { IM_CWD_PREFIX } from "@taco-ai/protocol";
import { focusManager } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGitWorkspace } from "../../src/hooks/useGitWorkspace";
import { queryWrapper } from "../helpers/queryWrapper";

const repository = {
    status: "repository" as const,
    repository: {
        checkoutRoot: "/parent",
        gitDir: "/parent/.git",
        commonDir: "/parent/.git",
        isBare: false,
        headOid: "abcdef1234567890",
        branch: "main",
    },
    changes: [],
};

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    focusManager.setFocused(undefined);
});

describe("useGitWorkspace", () => {
    it("shares an inspect query between both entries, without initializing", async () => {
        const client = { gitInspect: vi.fn().mockResolvedValue(repository), gitInit: vi.fn() };
        const { wrapper } = queryWrapper();
        const { result } = renderHook(
            () => [useGitWorkspace(client, "/parent/sub"), useGitWorkspace(client, "/parent/sub")],
            { wrapper },
        );
        await waitFor(() => expect(result.current[0].data?.status).toBe("repository"));
        expect(result.current[1].data).toEqual(repository);
        expect(client.gitInspect).toHaveBeenCalledExactlyOnceWith({ workspace: "/parent/sub" });
        expect(client.gitInit).not.toHaveBeenCalled();
    });

    it("initializes on demand and refreshes all observers", async () => {
        const client = {
            gitInspect: vi.fn().mockResolvedValue({ status: "not_repository" }),
            gitInit: vi.fn().mockImplementation(async () => {
                client.gitInspect.mockResolvedValue(repository);
                return repository;
            }),
        };
        const { wrapper } = queryWrapper();
        const { result } = renderHook(
            () => [useGitWorkspace(client, "/proj"), useGitWorkspace(client, "/proj")],
            { wrapper },
        );
        await waitFor(() => expect(result.current[0].data?.status).toBe("not_repository"));
        await act(async () => {
            await result.current[0].init();
        });
        await waitFor(() => expect(result.current[1].data).toEqual(repository));
        expect(client.gitInit).toHaveBeenCalledExactlyOnceWith({ workspace: "/proj" });
        expect(client.gitInspect.mock.calls.length).toBeGreaterThan(1);
    });

    it("does no work when the client or cwd is absent or entry is inactive", () => {
        const client = { gitInspect: vi.fn(), gitInit: vi.fn() };
        const { wrapper } = queryWrapper();
        renderHook(
            () => {
                useGitWorkspace(undefined, "/proj");
                useGitWorkspace(client, null);
                useGitWorkspace(client, "/proj", false);
            },
            { wrapper },
        );
        expect(client.gitInspect).not.toHaveBeenCalled();
    });

    it("refreshes every five seconds and on focus", async () => {
        vi.useFakeTimers();
        const client = { gitInspect: vi.fn().mockResolvedValue(repository), gitInit: vi.fn() };
        const { wrapper } = queryWrapper();
        renderHook(() => useGitWorkspace(client, "/proj"), { wrapper });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(client.gitInspect).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(client.gitInspect).toHaveBeenCalledTimes(2);
        await act(async () => {
            focusManager.setFocused(false);
            focusManager.setFocused(true);
            await vi.advanceTimersByTimeAsync(1);
        });
        expect(client.gitInspect).toHaveBeenCalledTimes(3);
    });

    it("isolates workspaces and allows recovery after a failed inspect", async () => {
        const client = {
            gitInspect: vi
                .fn()
                .mockRejectedValueOnce(new Error("offline"))
                .mockResolvedValue(repository),
            gitInit: vi.fn(),
        };
        const { wrapper } = queryWrapper();
        const { result, rerender } = renderHook(({ cwd }) => useGitWorkspace(client, cwd), {
            wrapper,
            initialProps: { cwd: "/one" },
        });
        await waitFor(() => expect(result.current.error).toBe("offline"));
        await act(async () => {
            await result.current.refresh();
        });
        await waitFor(() => expect(result.current.data).toEqual(repository));
        rerender({ cwd: "/two" });
        expect(result.current.data).toBeNull();
        await waitFor(() =>
            expect(client.gitInspect).toHaveBeenLastCalledWith({ workspace: "/two" }),
        );
    });
});

it("never inspects or initializes an IM workspace", async () => {
    const client = {
        gitInspect: vi.fn().mockResolvedValue({ status: "not_repository" }),
        gitInit: vi.fn(),
    };
    const { result } = renderHook(() => useGitWorkspace(client, `${IM_CWD_PREFIX}test`), {
        wrapper: queryWrapper().wrapper,
    });
    await act(async () => {
        await result.current.init();
        await result.current.refresh();
    });
    expect(client.gitInspect).not.toHaveBeenCalled();
    expect(client.gitInit).not.toHaveBeenCalled();
});
