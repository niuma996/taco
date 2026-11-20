import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorktreeLinks } from "../../src/components/WorkspaceWorktreeLinks";
import * as useI18n from "../../src/i18n/useI18n";
import { queryWrapper } from "../helpers/queryWrapper";

vi.spyOn(useI18n, "useT").mockReturnValue({ t: (key: string) => key } as ReturnType<
    typeof useI18n.useT
>);
const tree = (path: string, managed: boolean) => ({
    path,
    managed,
    branch: null,
    headOid: null,
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
});
const data = {
    status: "repository" as const,
    repository: {
        checkoutRoot: "/project",
        gitDir: "/project/.git",
        commonDir: "/project/.git",
        isBare: false,
        branch: "main",
        headOid: "abc",
    },
    worktrees: [
        tree("/project", false),
        tree("/project/.taco/worktrees/one", true),
        tree("/external", false),
    ],
};
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
describe("WorkspaceWorktreeLinks", () => {
    it("keeps the current managed worktree linked when querying from that checkout", async () => {
        const path = "/project/.taco/worktrees/one";
        const client = {
            worktreeList: vi.fn().mockResolvedValue({
                ...data,
                repository: {
                    ...data.repository,
                    checkoutRoot: path,
                    gitDir: "/project/.git/worktrees/one",
                },
            }),
        };
        const { wrapper } = queryWrapper();
        render(
            <WorkspaceWorktreeLinks
                client={client}
                cwd={path}
                activeCwd={path}
                active
                onSelect={vi.fn()}
            />,
            { wrapper },
        );
        expect(
            (await screen.findByRole("button", { name: /one/ })).getAttribute("data-active"),
        ).toBe("true");
    });

    it.each(["bare", "prunable", "orphaned"] as const)(
        "disables a %s managed link",
        async (state) => {
            const client = {
                worktreeList: vi.fn().mockResolvedValue({
                    ...data,
                    worktrees: [data.worktrees[0], { ...data.worktrees[1], [state]: true }],
                }),
            };
            const onSelect = vi.fn();
            const { wrapper } = queryWrapper();
            render(
                <WorkspaceWorktreeLinks
                    client={client}
                    cwd="/project"
                    activeCwd="/project"
                    active
                    onSelect={onSelect}
                />,
                { wrapper },
            );
            const button = await screen.findByRole("button", { name: /one/ });
            expect(button).toHaveProperty("disabled", true);
            fireEvent.click(button);
            expect(onSelect).not.toHaveBeenCalled();
        },
    );

    it("keeps orphaned history out of executable sidebar links", async () => {
        const client = {
            worktreeList: vi.fn().mockResolvedValue({
                ...data,
                worktrees: [
                    ...data.worktrees,
                    { ...tree("/project/.taco/worktrees/orphan", false), orphaned: true },
                ],
            }),
        };
        const { wrapper } = queryWrapper();
        render(
            <WorkspaceWorktreeLinks
                client={client}
                cwd="/project"
                activeCwd="/project"
                active
                onSelect={vi.fn()}
            />,
            { wrapper },
        );
        await screen.findByRole("button", { name: /one/ });
        expect(screen.queryByRole("button", { name: /orphan/ })).toBeNull();
    });

    it("shows only managed worktrees and opens the selected directory", async () => {
        const client = { worktreeList: vi.fn().mockResolvedValue(data) };
        const onSelect = vi.fn();
        const { wrapper } = queryWrapper();
        render(
            <WorkspaceWorktreeLinks
                client={client}
                cwd="/project"
                activeCwd="/project/.taco/worktrees/one"
                active
                onSelect={onSelect}
            />,
            { wrapper },
        );
        const button = await screen.findByRole("button", { name: /one/ });
        expect(button.getAttribute("data-active")).toBe("true");
        expect(screen.queryByRole("button", { name: /external/ })).toBeNull();
        fireEvent.click(button);
        expect(onSelect).toHaveBeenCalledExactlyOnceWith("/project/.taco/worktrees/one");
    });
});
