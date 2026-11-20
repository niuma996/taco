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
