import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorktreesDialog } from "../../src/components/WorktreesDialog";
import * as useI18n from "../../src/i18n/useI18n";
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
const linkedPath = "/project/.taco/worktrees/review";
const linkedRepository = {
    ...repository,
    repository: {
        ...repository.repository,
        checkoutRoot: linkedPath,
        gitDir: "/project/.git/worktrees/review",
        branch: "worktree-review",
    },
};

function setup(overrides: { list?: unknown; cwd?: string; activeCwd?: string } = {}) {
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
    const props = {
        client,
        cwd: overrides.cwd ?? "/project",
        activeCwd: overrides.activeCwd ?? linkedPath,
        open: true,
        onClose: vi.fn(),
        onOpenWorkspace,
    };
    const view = render(<WorktreesDialog {...props} />, { wrapper });
    return { client, onOpenWorkspace, props, view };
}
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("WorktreesDialog", () => {
    it("scopes the list to the owning repository", async () => {
        setup();
        expect(await screen.findByText("/project")).toBeTruthy();
        expect(screen.getByText("worktree-review")).toBeTruthy();
        expect(screen.getByText("worktrees.scope")).toBeTruthy();
    });

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

    it("creates a worktree from the head of the worktree the user is on", async () => {
        const { client, onOpenWorkspace } = setup();
        await screen.findByRole("button", { name: "worktrees.open worktree-review" });
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        fireEvent.change(await screen.findByLabelText("worktrees.name"), {
            target: { value: "  review-2  " },
        });
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.createConfirm" }));
        await waitFor(() =>
            expect(client.worktreeCreate).toHaveBeenCalledExactlyOnceWith({
                // The base is the HEAD the user is looking at, so the create
                // call is anchored to their worktree rather than the repo root.
                workspace: linkedPath,
                name: "review-2",
                base: "head",
            }),
        );
        expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project/.taco/worktrees/review");
    });

    it("moves focus into the create form and back to the trigger button", async () => {
        setup();
        await screen.findByRole("button", { name: "worktrees.open worktrees.local" });
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        const input = await screen.findByLabelText("worktrees.name");
        await waitFor(() => expect(document.activeElement).toBe(input));

        fireEvent.click(screen.getByRole("button", { name: "worktrees.cancel" }));
        await waitFor(() =>
            expect(document.activeElement).toBe(
                screen.getByRole("button", { name: "worktrees.create" }),
            ),
        );
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
        expect(screen.queryByLabelText("worktrees.name")).toBeNull();
    });

    it("returns to the main checkout after removing the current worktree", async () => {
        const { onOpenWorkspace } = setup();
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.removeConfirm" }));
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project"));
    });

    it("labels the main checkout and allows removing the queried linked worktree", async () => {
        const { client, onOpenWorkspace } = setup({ list: linkedRepository, cwd: linkedPath });
        const local = await screen.findByRole("button", { name: "worktrees.open worktrees.local" });
        expect(local.getAttribute("data-worktree-open")).toBe("/project");
        fireEvent.click(screen.getByRole("button", { name: "worktrees.remove worktree-review" }));
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.removeConfirm" }));
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project"));
        expect(client.worktreeRemove).toHaveBeenCalledExactlyOnceWith({
            workspace: linkedPath,
            path: linkedPath,
        });
        expect(client.worktreeList).toHaveBeenCalledTimes(1);
    });

    it("returns from a subdirectory of the removed current worktree", async () => {
        const { onOpenWorkspace } = setup({
            list: linkedRepository,
            cwd: `${linkedPath}/src`,
            activeCwd: `${linkedPath}/src`,
        });
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "worktrees.removeConfirm" }));
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project"));
    });

    it("prefers the verified projectRoot over a separate Git directory inventory entry", async () => {
        const { onOpenWorkspace } = setup({
            cwd: linkedPath,
            list: {
                ...linkedRepository,
                projectRoot: "/project",
                repository: { ...linkedRepository.repository, commonDir: "/git-data" },
                worktrees: [tree("/git-data", "main"), linkedRepository.worktrees[1]],
            },
        });
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "worktrees.removeConfirm" }));
        await waitFor(() => expect(onOpenWorkspace).toHaveBeenCalledExactlyOnceWith("/project"));
    });

    it("allows forgetting a stale record without enabling navigation", async () => {
        const { client, onOpenWorkspace } = setup({
            list: {
                ...repository,
                worktrees: [
                    repository.worktrees[0],
                    {
                        ...tree("/missing", "worktree-missing"),
                        prunable: true,
                        orphaned: true,
                        stale: true,
                    },
                ],
            },
        });
        const open = await screen.findByRole("button", {
            name: "worktrees.open worktree-missing",
        });
        expect(open).toHaveProperty("disabled", true);
        const remove = screen.getByRole("button", { name: "worktrees.forget worktree-missing" });
        expect(remove).toHaveProperty("disabled", false);
        fireEvent.click(remove);
        fireEvent.click(await screen.findByRole("button", { name: "worktrees.forget" }));
        await waitFor(() =>
            expect(client.worktreeRemove).toHaveBeenCalledExactlyOnceWith({
                workspace: "/project",
                path: "/missing",
                forgetMissing: true,
            }),
        );
        expect(onOpenWorkspace).not.toHaveBeenCalled();
    });

    it("keeps a prunable entry without a verified record unremovable", async () => {
        setup({
            list: {
                ...repository,
                worktrees: [
                    repository.worktrees[0],
                    { ...tree("/missing", "worktree-missing"), prunable: true, orphaned: true },
                ],
            },
        });
        await screen.findByRole("button", { name: "worktrees.open worktree-missing" });
        expect(
            screen.queryByRole("button", { name: "worktrees.remove worktree-missing" }),
        ).toBeNull();
    });

    it.each(["bare", "prunable", "orphaned"] as const)(
        "disables navigation and removal for a %s entry",
        async (state) => {
            const { onOpenWorkspace, client } = setup({
                list: {
                    ...repository,
                    worktrees: [
                        repository.worktrees[0],
                        {
                            ...repository.worktrees[1],
                            [state]: true,
                        },
                    ],
                },
            });
            const open = await screen.findByRole("button", {
                name: "worktrees.open worktree-review",
            });
            expect(open).toHaveProperty("disabled", true);
            const remove = screen.queryByRole("button", {
                name: "worktrees.remove worktree-review",
            });
            if (remove) expect(remove).toHaveProperty("disabled", true);
            fireEvent.click(open);
            expect(onOpenWorkspace).not.toHaveBeenCalled();
            expect(client.worktreeRemove).not.toHaveBeenCalled();
        },
    );

    it("skips unavailable entries during keyboard navigation", async () => {
        setup({
            list: {
                ...repository,
                worktrees: [
                    repository.worktrees[0],
                    { ...tree("/missing", "missing"), prunable: true },
                    repository.worktrees[1],
                ],
            },
        });
        const local = await screen.findByRole("button", { name: "worktrees.open worktrees.local" });
        local.focus();
        fireEvent.keyDown(local, { key: "ArrowDown" });
        expect(document.activeElement).toBe(
            screen.getByRole("button", { name: "worktrees.open worktree-review" }),
        );
    });

    it("preserves a locked live tree for navigation while preventing removal", async () => {
        setup({
            list: {
                ...repository,
                worktrees: [
                    repository.worktrees[0],
                    {
                        ...repository.worktrees[1],
                        locked: true,
                        lockReason: "in use",
                    },
                ],
            },
        });
        expect(
            await screen.findByRole("button", { name: "worktrees.open worktree-review" }),
        ).toHaveProperty("disabled", false);
        expect(
            screen.getByRole("button", { name: "worktrees.remove worktree-review" }),
        ).toHaveProperty("disabled", true);
    });

    it.each(["create", "remove"] as const)(
        "ignores a delayed %s result after switching workspace",
        async (action) => {
            const { client, onOpenWorkspace, props, view } = setup();
            let complete!: () => void;
            if (action === "create") {
                client.worktreeCreate.mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            complete = () =>
                                resolve({
                                    path: linkedPath,
                                    branch: "worktree-review",
                                    headOid: "abc",
                                    managed: true,
                                });
                        }),
                );
                await screen.findByText("/project");
                fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
                fireEvent.change(await screen.findByLabelText("worktrees.name"), {
                    target: { value: "review" },
                });
                fireEvent.click(screen.getByRole("button", { name: "worktrees.createConfirm" }));
            } else {
                client.worktreeRemove.mockImplementationOnce(
                    () =>
                        new Promise((resolve) => {
                            complete = () =>
                                resolve({
                                    path: linkedPath,
                                    branch: "worktree-review",
                                    removed: true,
                                });
                        }),
                );
                fireEvent.click(
                    await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
                );
                fireEvent.click(screen.getByRole("button", { name: "worktrees.removeConfirm" }));
            }
            await waitFor(() => expect(complete).toBeTypeOf("function"));
            view.rerender(<WorktreesDialog {...props} cwd="/other" activeCwd="/other" />);
            // The scope change remounts the content, so the pending step goes
            // away with it: the create form closes and the confirmation closes.
            expect(screen.getAllByRole("dialog")).toHaveLength(1);
            if (action === "create") {
                expect(screen.queryByLabelText("worktrees.name")).toBeNull();
            } else {
                expect(
                    screen.queryByRole("button", { name: "worktrees.removeConfirm" }),
                ).toBeNull();
            }
            await act(async () => complete());
            expect(onOpenWorkspace).not.toHaveBeenCalled();
        },
    );

    it("does not return to a removed tree when the active workspace changes during removal", async () => {
        const { client, onOpenWorkspace, props, view } = setup();
        let complete!: () => void;
        client.worktreeRemove.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = () =>
                        resolve({ path: linkedPath, branch: "worktree-review", removed: true });
                }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "worktrees.removeConfirm" }));
        view.rerender(<WorktreesDialog {...props} activeCwd="/other" />);
        await act(async () => complete());
        expect(onOpenWorkspace).not.toHaveBeenCalled();
        // The tree is gone either way: the confirmation closes and the list
        // refreshes, so the row cannot linger as a second, failing delete.
        expect(screen.queryByRole("button", { name: "worktrees.removeConfirm" })).toBeNull();
        await waitFor(() => expect(client.worktreeList).toHaveBeenCalledTimes(2));
    });

    it("does not navigate to a created worktree when the active workspace changes during creation", async () => {
        const { client, onOpenWorkspace, props, view } = setup();
        let complete!: () => void;
        client.worktreeCreate.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = () =>
                        resolve({
                            path: linkedPath,
                            branch: "worktree-review",
                            headOid: "abc",
                            managed: true,
                        });
                }),
        );
        await screen.findByText("/project");
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        fireEvent.change(await screen.findByLabelText("worktrees.name"), {
            target: { value: "review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "worktrees.createConfirm" }));
        view.rerender(<WorktreesDialog {...props} activeCwd="/other" />);
        await act(async () => complete());
        // The tree exists, but the user already moved on — do not pull them
        // back into it.
        expect(client.worktreeCreate).toHaveBeenCalledTimes(1);
        expect(onOpenWorkspace).not.toHaveBeenCalled();
    });

    it("does not navigate when a create finishes after the dialog closes", async () => {
        const { client, onOpenWorkspace, props, view } = setup();
        let complete!: () => void;
        client.worktreeCreate.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = () =>
                        resolve({
                            path: linkedPath,
                            branch: "worktree-review",
                            headOid: "abc",
                            managed: true,
                        });
                }),
        );
        await screen.findByText("/project");
        fireEvent.click(screen.getByRole("button", { name: "worktrees.create" }));
        fireEvent.change(await screen.findByLabelText("worktrees.name"), {
            target: { value: "review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "worktrees.createConfirm" }));
        view.rerender(<WorktreesDialog {...props} open={false} />);
        await act(async () => complete());
        expect(onOpenWorkspace).not.toHaveBeenCalled();
    });

    it("keeps the removal dialog open when the server refuses removal", async () => {
        const { client } = setup();
        client.worktreeRemove.mockRejectedValue(new Error("active session"));
        fireEvent.click(
            await screen.findByRole("button", { name: "worktrees.remove worktree-review" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "worktrees.removeConfirm" }));
        expect((await screen.findByRole("alert")).textContent).toContain("active session");
        // The confirmation is the topmost dialog, so it is the only one the
        // accessibility tree exposes while it stays open.
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(screen.getByRole("button", { name: "worktrees.removeConfirm" })).toBeTruthy();
    });

    it("requires a first commit before offering worktree creation", async () => {
        setup({ list: { ...repository, repository: { ...repository.repository, headOid: null } } });
        await screen.findByRole("button", { name: "worktrees.open worktrees.local" });
        expect(screen.getByRole("button", { name: "worktrees.create" })).toHaveProperty(
            "disabled",
            true,
        );
        expect(screen.getByTitle("worktrees.commitFirst")).toBeTruthy();
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
