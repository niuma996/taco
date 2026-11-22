import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorktreePicker } from "../../src/components/WorkspaceWorktreePicker";
import en from "../../src/i18n/locales/en.json";
import zh from "../../src/i18n/locales/zh.json";
import * as useI18n from "../../src/i18n/useI18n";
import { queryWrapper } from "../helpers/queryWrapper";

vi.spyOn(useI18n, "useT").mockReturnValue({ t: (key: string) => key } as ReturnType<
    typeof useI18n.useT
>);
const list = {
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
        {
            path: "/project/.taco/worktrees/review",
            branch: "worktree-review",
            headOid: "def",
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
            managed: true,
        },
    ],
};
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});
function setup(cwd = "/project", response: typeof list & { projectRoot?: string } = list) {
    const client = { worktreeList: vi.fn().mockResolvedValue(response) };
    const onSelect = vi.fn(),
        onManage = vi.fn();
    const { wrapper } = queryWrapper();
    render(
        <WorkspaceWorktreePicker
            client={client}
            cwd={cwd}
            onSelect={onSelect}
            onManage={onManage}
        />,
        { wrapper },
    );
    return { onSelect, onManage };
}
describe("WorkspaceWorktreePicker", () => {
    it("has localized labels for the switcher", () => {
        expect(typeof en.worktrees.switch).toBe("string");
        expect(typeof zh.worktrees.switch).toBe("string");
    });

    it("queries only the current workspace", async () => {
        const client = { worktreeList: vi.fn().mockResolvedValue(list) };
        const view = render(
            <WorkspaceWorktreePicker
                client={client}
                cwd="/project"
                onSelect={vi.fn()}
                onManage={vi.fn()}
            />,
            { wrapper: queryWrapper().wrapper },
        );
        await screen.findByRole("button", { name: "worktrees.switch" });

        view.rerender(
            <WorkspaceWorktreePicker
                client={client}
                cwd="/other"
                onSelect={vi.fn()}
                onManage={vi.fn()}
            />,
        );

        await waitFor(() =>
            expect(client.worktreeList).toHaveBeenLastCalledWith({ workspace: "/other" }),
        );
        expect(client.worktreeList).toHaveBeenCalledTimes(2);
        expect(client.worktreeList).toHaveBeenNthCalledWith(1, { workspace: "/project" });
    });

    it.each(["not_repository", "missing"] as const)(
        "stays hidden when the current workspace has no usable Git repository: %s",
        async (status) => {
            const client = { worktreeList: vi.fn().mockResolvedValue({ status }) };
            render(
                <WorkspaceWorktreePicker
                    client={client}
                    cwd="/other"
                    onSelect={vi.fn()}
                    onManage={vi.fn()}
                />,
                { wrapper: queryWrapper().wrapper },
            );

            await waitFor(() => expect(client.worktreeList).toHaveBeenCalledTimes(1));
            expect(screen.queryByRole("button", { name: "worktrees.switch" })).toBeNull();
        },
    );

    it("switches between the local checkout and worktrees", async () => {
        const { onSelect } = setup();
        expect(await screen.findByRole("button", { name: "worktrees.switch" })).toHaveProperty(
            "disabled",
            false,
        );
        fireEvent.pointerDown(screen.getByRole("button", { name: "worktrees.switch" }), {
            button: 0,
            ctrlKey: false,
        });
        fireEvent.click(await screen.findByRole("menuitemradio", { name: /worktree-review/ }));
        expect(onSelect).toHaveBeenCalledExactlyOnceWith("/project/.taco/worktrees/review");
    });
    it("leaves the current draft intact when reselecting its checkout", async () => {
        const { onSelect } = setup();
        fireEvent.pointerDown(await screen.findByRole("button", { name: "worktrees.switch" }), {
            button: 0,
            ctrlKey: false,
        });
        fireEvent.click(await screen.findByRole("menuitemradio", { name: "worktrees.local" }));

        expect(onSelect).not.toHaveBeenCalled();
    });

    it("navigates to the checkout instead of a separate Git directory", async () => {
        const linked = list.worktrees[1].path;
        const commonDir = "/metadata";
        const { onSelect } = setup(linked, {
            ...list,
            projectRoot: "/project",
            repository: { ...list.repository, commonDir, checkoutRoot: linked },
            worktrees: [{ ...list.worktrees[0], path: commonDir }, list.worktrees[1]],
        });
        fireEvent.pointerDown(await screen.findByRole("button", { name: "worktrees.switch" }), {
            button: 0,
            ctrlKey: false,
        });
        fireEvent.click(await screen.findByRole("menuitemradio", { name: "worktrees.local" }));
        expect(onSelect).toHaveBeenCalledExactlyOnceWith("/project");
    });
    it.each(["bare", "prunable", "orphaned"] as const)(
        "disables %s destinations",
        async (state) => {
            const { onSelect } = setup("/project", {
                ...list,
                worktrees: [list.worktrees[0], { ...list.worktrees[1], [state]: true }],
            });
            fireEvent.pointerDown(await screen.findByRole("button", { name: "worktrees.switch" }), {
                button: 0,
                ctrlKey: false,
            });
            const item = await screen.findByRole("menuitemradio", { name: /worktree-review/ });
            expect(item.getAttribute("aria-disabled")).toBe("true");
            fireEvent.click(item);
            expect(onSelect).not.toHaveBeenCalled();
        },
    );
    it("opens the management view and labels the current worktree", async () => {
        const { onManage } = setup("/project/.taco/worktrees/review", {
            ...list,
            repository: {
                ...list.repository,
                checkoutRoot: "/project/.taco/worktrees/review",
                gitDir: "/project/.git/worktrees/review",
                branch: "worktree-review",
            },
        });
        expect(await screen.findByText("review")).toBeTruthy();
        fireEvent.pointerDown(screen.getByRole("button", { name: "worktrees.switch" }), {
            button: 0,
            ctrlKey: false,
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: "worktrees.manage" }));
        expect(onManage).toHaveBeenCalledTimes(1);
    });
});
