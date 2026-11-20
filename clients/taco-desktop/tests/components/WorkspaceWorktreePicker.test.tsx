import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceWorktreePicker } from "../../src/components/WorkspaceWorktreePicker";
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
function setup(cwd = "/project") {
    const client = { worktreeList: vi.fn().mockResolvedValue(list) };
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
    it("opens the management view and labels the current worktree", async () => {
        const { onManage } = setup("/project/.taco/worktrees/review");
        expect(await screen.findByText("review")).toBeTruthy();
        fireEvent.pointerDown(screen.getByRole("button", { name: "worktrees.switch" }), {
            button: 0,
            ctrlKey: false,
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: "worktrees.manage" }));
        expect(onManage).toHaveBeenCalledTimes(1);
    });
});
