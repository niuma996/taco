import { focusManager } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGitStatus } from "../../src/components/WorkspaceGitStatus";
import * as useI18n from "../../src/i18n/useI18n";
import { queryWrapper } from "../helpers/queryWrapper";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.spyOn(useI18n, "useT").mockReturnValue({ t: (key: string) => key } as ReturnType<
    typeof useI18n.useT
>);
const repo = {
    status: "repository",
    repository: {
        checkoutRoot: "/proj",
        gitDir: "/proj/.git",
        commonDir: "/proj/.git",
        isBare: false,
        branch: "feature/a-very-long-branch-name",
        headOid: "123456789abcdef",
    },
    changes: [],
};
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    focusManager.setFocused(undefined);
});
function mount(data: unknown, notify = vi.fn()) {
    const client = {
        gitInspect: vi.fn().mockResolvedValue(data),
        gitInit: vi.fn().mockResolvedValue(repo),
    };
    const { wrapper } = queryWrapper();
    render(<WorkspaceGitStatus client={client} cwd="/proj" notify={notify} />, { wrapper });
    return { client, notify };
}
describe("WorkspaceGitStatus", () => {
    it("shows loading then the full branch in its title", async () => {
        mount(repo);
        expect(screen.getByText("git.loading")).toBeTruthy();
        expect(await screen.findByText(repo.repository.branch)).toBeTruthy();
        expect(screen.getByText(repo.repository.branch).title).toBe(repo.repository.branch);
        expect(screen.queryByRole("button", { name: "git.create" })).toBeNull();
    });
    it("keeps the branch visible without a background refresh indicator", async () => {
        const { client } = mount(repo);
        await screen.findByText(repo.repository.branch);
        let complete: ((value: typeof repo) => void) | undefined;
        client.gitInspect.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        await act(async () => {
            focusManager.setFocused(false);
            focusManager.setFocused(true);
        });
        await waitFor(() => expect(client.gitInspect).toHaveBeenCalledTimes(2));
        expect(screen.getByText(repo.repository.branch)).toBeTruthy();
        expect(screen.queryByText("git.refreshing")).toBeNull();
        expect(screen.getByLabelText("git.status").getAttribute("aria-busy")).toBe("false");
        await act(async () => {
            complete?.(repo);
        });
    });
    it("offers explicit initialization only for a non-repository", async () => {
        const { client } = mount({ status: "not_repository" });
        const create = await screen.findByRole("button", { name: "git.create" });
        expect(client.gitInit).not.toHaveBeenCalled();
        fireEvent.click(create);
        await waitFor(() => expect(client.gitInit).toHaveBeenCalledWith({ workspace: "/proj" }));
    });
    it("opens installation guidance and lets the user recheck", async () => {
        const { client } = mount({ status: "missing" });
        fireEvent.click(await screen.findByRole("button", { name: "git.install" }));
        await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://git-scm.com/downloads"));
        fireEvent.click(screen.getByRole("button", { name: "git.retry" }));
        await waitFor(() => expect(client.gitInspect).toHaveBeenCalledTimes(2));
        expect(client.gitInit).not.toHaveBeenCalled();
    });
    it("shows bare repositories and detached HEAD without initialization", async () => {
        const { wrapper } = queryWrapper();
        const client = {
            gitInspect: vi.fn().mockResolvedValue({
                ...repo,
                repository: {
                    ...repo.repository,
                    isBare: true,
                    checkoutRoot: null,
                    branch: null,
                },
            }),
            gitInit: vi.fn(),
        };
        const view = render(<WorkspaceGitStatus client={client} cwd="/proj" />, { wrapper });
        expect(await screen.findByText("git.bare")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "git.create" })).toBeNull();
        view.unmount();
        mount({ ...repo, repository: { ...repo.repository, branch: null } });
        expect(await screen.findByText(/git.detached/)).toBeTruthy();
    });
    it("reports initialization failure and keeps retry available", async () => {
        const { client, notify } = mount({ status: "not_repository" });
        client.gitInit.mockRejectedValue(new Error("permission denied"));
        fireEvent.click(await screen.findByRole("button", { name: "git.create" }));
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("button", { name: "git.create" }).hasAttribute("disabled")).toBe(
            false,
        );
    });
    it("reports inspect errors with a retry action", async () => {
        const client = {
            gitInspect: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(repo),
            gitInit: vi.fn(),
        };
        const { wrapper } = queryWrapper();
        render(<WorkspaceGitStatus client={client} cwd="/proj" />, { wrapper });
        expect(await screen.findByRole("alert")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "git.retry" }));
        expect(await screen.findByText(repo.repository.branch)).toBeTruthy();
    });
});
