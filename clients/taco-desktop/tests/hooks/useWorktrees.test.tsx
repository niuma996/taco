import { focusManager } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorktrees } from "../../src/hooks/useWorktrees";
import { queryWrapper } from "../helpers/queryWrapper";

const result = {
    status: "repository" as const,
    repository: {
        checkoutRoot: "/project",
        gitDir: "/project/.git",
        commonDir: "/project/.git",
        isBare: false,
        headOid: "abc",
        branch: "main",
    },
    worktrees: [
        {
            path: "/project",
            branch: "main",
            headOid: "abc",
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
        },
    ],
};

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    focusManager.setFocused(undefined);
});

describe("useWorktrees", () => {
    it("loads a project inventory only for enabled filesystem workspaces", async () => {
        const client = { worktreeList: vi.fn().mockResolvedValue(result) };
        const { wrapper } = queryWrapper();
        const view = renderHook(({ cwd, active }) => useWorktrees(client, cwd, active), {
            wrapper,
            initialProps: { cwd: "/project", active: true },
        });
        await waitFor(() => expect(view.result.current.data).toEqual(result));
        expect(client.worktreeList).toHaveBeenCalledExactlyOnceWith({ workspace: "/project" });
        view.rerender({ cwd: "im://channel/chat", active: true });
        expect(view.result.current.data).toBeNull();
        view.rerender({ cwd: "/project", active: false });
        expect(view.result.current.data).toBeNull();
        expect(client.worktreeList).toHaveBeenCalledTimes(1);
    });

    it("keeps loaded inventory visible during a background refresh", async () => {
        const client = { worktreeList: vi.fn().mockResolvedValue(result) };
        const { wrapper } = queryWrapper();
        const view = renderHook(() => useWorktrees(client, "/project"), { wrapper });
        await waitFor(() => expect(view.result.current.data).toEqual(result));
        let resolve!: (value: typeof result) => void;
        client.worktreeList.mockImplementationOnce(
            () =>
                new Promise<typeof result>((done) => {
                    resolve = done;
                }),
        );
        await act(async () => {
            focusManager.setFocused(false);
            focusManager.setFocused(true);
        });
        await waitFor(() => expect(view.result.current.refreshing).toBe(true));
        expect(view.result.current.data).toEqual(result);
        await act(async () => resolve(result));
    });
});
