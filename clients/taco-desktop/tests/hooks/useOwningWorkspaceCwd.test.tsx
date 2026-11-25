import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "../helpers/queryWrapper";

const mainList = {
    status: "repository" as const,
    projectRoot: "/project",
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

afterEach(cleanup);

describe("useOwningWorkspaceCwd", () => {
    it("keeps the owning checkout stable while moving to a linked worktree", async () => {
        const { useOwningWorkspaceCwd } = await import("../../src/hooks/useWorktrees");

        let completeLinked!: (value: typeof mainList) => void;
        const linkedPath = "/project/.claude/worktrees/settings-visual-refinement";
        const client = {
            worktreeList: vi
                .fn()
                .mockResolvedValueOnce(mainList)
                .mockImplementationOnce(
                    () =>
                        new Promise<typeof mainList>((resolve) => {
                            completeLinked = resolve;
                        }),
                )
                .mockResolvedValue({ status: "not_repository" }),
        };
        const { wrapper } = queryWrapper();
        const view = renderHook(({ cwd }) => useOwningWorkspaceCwd(client, cwd), {
            wrapper,
            initialProps: { cwd: "/project" },
        });
        await waitFor(() => expect(view.result.current).toBe("/project"));

        view.rerender({ cwd: linkedPath });
        expect(view.result.current).toBe("/project");
        completeLinked({
            ...mainList,
            repository: {
                ...mainList.repository,
                checkoutRoot: linkedPath,
                gitDir: "/project/.git/worktrees/settings-visual-refinement",
                branch: "worktree-settings-visual-refinement",
            },
        });
        await waitFor(() => expect(client.worktreeList).toHaveBeenCalledTimes(2));
        expect(view.result.current).toBe("/project");

        view.rerender({ cwd: "/plain-directory" });
        await waitFor(() => expect(view.result.current).toBe("/plain-directory"));
    });
});
