import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as useI18n from "../../src/i18n/useI18n";
import { WorktreesPane } from "../../src/views/WorktreesPane";
import { queryWrapper } from "../helpers/queryWrapper";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.spyOn(useI18n, "useT").mockReturnValue({ t: (key: string) => key } as ReturnType<
    typeof useI18n.useT
>);

const tree = (path: string, branch: string | null, managed = false) => ({
    path,
    branch,
    headOid: "123456789abcdef",
    detached: branch === null,
    bare: false,
    locked: false,
    prunable: false,
    managed,
});
const repository = {
    status: "repository" as const,
    repository: {
        checkoutRoot: "/project",
        gitDir: "/project/.git",
        commonDir: "/project/.git",
        isBare: false,
        headOid: "123456789abcdef",
        branch: "main",
    },
    worktrees: [
        tree("/project", "main"),
        tree("/project/.taco/worktrees/review", "worktree-review", true),
    ],
};
function setup(overrides: { list?: unknown } = {}) {
    const client = {
        worktreeList: vi.fn().mockResolvedValue(overrides.list ?? repository),
        worktreeCreate: vi.fn().mockResolvedValue({
            path: "/project/.taco/worktrees/review",
            branch: "worktree-review",
            headOid: "abc",
            managed: true,
        }),
        worktreeRemove: vi.fn().mockResolvedValue({
            path: "/project/.taco/worktrees/review",
            branch: "worktree-review",
            removed: true,
        }),
        gitInspect: vi.fn().mockResolvedValue(repository),
        gitInit: vi.fn(),
    };
    const onOpenWorkspace = vi.fn<(cwd: string) => void>();
    const { wrapper } = queryWrapper();
    render(
        <WorktreesPane
            client={client}
            cwd="/project"
            activeCwd="/project/.taco/worktrees/review"
            onOpenWorkspace={onOpenWorkspace}
        />,
        { wrapper },
    );
    return { client, onOpenWorkspace };
}
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("WorktreesPane", () => {
    it("lists the checkout and managed worktrees and opens either location", async () => {
        const { onOpenWorkspace } = setup();
        expect(await screen.findByText("/project")).toBeTruthy();
        expect(screen.getByText("worktree-review")).toBeTruthy();
        expect(screen.getAllByText("worktrees.current")).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "worktrees.open worktrees.local" }));
        expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project");
        fireEvent.click(screen.getByRole("button", { name: "worktrees.open worktree-review" }));
        expect(onOpenWorkspace).toHaveBeenCalledWith("/project/.taco/worktrees/review");
        expect(screen.queryByRole("button", { name: "worktrees.remove /project" })).toBeNull();
    });

    it("creates a worktree from HEAD and opens it", async () => {
        const { client, onOpenWorkspace } = setup();
        await screen.findByRole("button", { name: "worktrees.open worktree-review" });
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        fireEvent.change(await screen.findByLabelText("worktrees.name"), {
            target: { value: "  review-2  " },
        });
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.createConfirm" }));
        await waitFor(() =>
            expect(client.worktreeCreate).toHaveBeenCalledExactlyOnceWith({
                workspace: "/project",
                name: "review-2",
                base: "head",
            }),
        );
        expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project/.taco/worktrees/review");
    });

    it("opens a successfully created worktree even if inventory refresh fails", async () => {
        const { client, onOpenWorkspace } = setup();
        client.worktreeList
            .mockResolvedValueOnce(repository)
            .mockRejectedValueOnce(new Error("offline"));
        await screen.findByRole("button", { name: "worktrees.open worktree-review" });
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        fireEvent.change(await screen.findByLabelText("worktrees.name"), {
            target: { value: "review-2" },
        });
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.createConfirm" }));
        await waitFor(() =>
            expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith(
                "/project/.taco/worktrees/review",
            ),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("returns to the main checkout after removing the current worktree", async () => {
        const { onOpenWorkspace } = setup();
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.removeConfirm" }));
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project"));
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("keeps the removal dialog open when the server refuses removal", async () => {
        const { client } = setup();
        client.worktreeRemove.mockRejectedValue(new Error("active session"));
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "worktrees.removeConfirm" }));
        expect((await screen.findByRole("alert")).textContent).toContain("active session");
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.getByRole("button", { name: "worktrees.removeConfirm" })).toBeTruthy();
    });

    it("enables creation immediately after initializing the repository", async () => {
        const { client } = setup({ list: { status: "not_repository" } });
        client.gitInspect.mockResolvedValue({ status: "not_repository" });
        client.gitInit.mockImplementation(async () => {
            client.gitInspect.mockResolvedValue(repository);
            client.worktreeList.mockResolvedValue(repository);
            return repository;
        });
        fireEvent.click(await screen.findByRole("button", { name: "git.create" }));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "worktrees.create" })).toHaveProperty(
                "disabled",
                false,
            ),
        );
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        expect(await screen.findByLabelText("worktrees.name")).toBeTruthy();
    });

    it("reuses the existing Git initialization and installation guidance", async () => {
        const { client } = setup({ list: { status: "not_repository" } });
        client.gitInspect.mockResolvedValue({ status: "not_repository" });
        fireEvent.click(await screen.findByRole("button", { name: "git.create" }));
        await waitFor(() => expect(client.gitInit).toHaveBeenCalledWith({ workspace: "/project" }));
        expect(client.worktreeCreate).not.toHaveBeenCalled();
    });
});
