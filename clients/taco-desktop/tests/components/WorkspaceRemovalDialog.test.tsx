import { asWorkspaceId, makeImCwd, type WorkspaceCleanupResult } from "@taco-ai/protocol";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRemovalDialog } from "../../src/components/WorkspaceRemovalDialog";
import en from "../../src/i18n/locales/en.json";
import zh from "../../src/i18n/locales/zh.json";
import type { TacoClient } from "../../src/lib/clients/tacoClient";

vi.mock("../../src/i18n/useI18n", () => ({
    useT: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
    cleanup();
    document.body.style.pointerEvents = "";
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const preview: WorkspaceCleanupResult = {
    removed: ["/data/taco/workspace/sessions", "/repo/project/.taco"],
    skipped: [{ path: "/repo/project", reason: "source directory" }],
    failed: [],
};

function setup(overrides: Partial<React.ComponentProps<typeof WorkspaceRemovalDialog>> = {}) {
    const workspaceCleanupPreview = vi.fn().mockResolvedValue(preview);
    const input = {
        cwd: "/repo/project",
        cleanup: false,
        client: { workspaceCleanupPreview } as unknown as TacoClient,
        onRemove: vi
            .fn<React.ComponentProps<typeof WorkspaceRemovalDialog>["onRemove"]>()
            .mockResolvedValue(undefined),
        onClose: vi.fn(),
        ...overrides,
    };
    render(<WorkspaceRemovalDialog {...input} />);
    return { ...input, workspaceCleanupPreview };
}

describe("WorkspaceRemovalDialog", () => {
    it.each([
        {
            language: "en",
            copy: en.workspaceRemoval,
            currentView: "current view will stay open",
            fallback: "another workspace or an empty view",
            incoming: "without switching your current view",
        },
        {
            language: "zh",
            copy: zh.workspaceRemoval,
            currentView: "当前页面保持打开",
            fallback: "其他工作区或空白页",
            incoming: "不会切换当前页面",
        },
    ])(
        "describes removal navigation and separates final actions from menus in $language",
        ({ copy, currentView, fallback, incoming }) => {
            expect(copy.hideLocalHint).not.toContain(currentView);
            expect(copy.hideImHint).not.toContain(currentView);
            expect(copy.hideImHint).toContain(fallback);
            expect(copy.hideImHint).toContain(incoming);
            expect(Object.values(copy).some((text) => /(?:…|\.\.\.)$/.test(text))).toBe(false);
            expect(copy).toHaveProperty("confirmRemoveAndClean");
            expect(copy).toHaveProperty("confirmDeleteIm");
            if ("confirmRemoveAndClean" in copy && "confirmDeleteIm" in copy) {
                expect(copy.confirmRemoveAndClean).not.toMatch(/…$/);
                expect(copy.confirmDeleteIm).not.toMatch(/…$/);
            }
        },
    );

    it.each([false, true])(
        "explains restoration for remove-only (IM: %s) without requesting cleanup",
        async (im) => {
            const input = setup({ cwd: im ? makeImCwd("wecom", "peer", "chat") : "/repo/project" });
            expect(
                screen.getByText(
                    im ? "workspaceRemoval.hideImHint" : "workspaceRemoval.hideLocalHint",
                ),
            ).toBeTruthy();
            expect(screen.getByText("workspaceRemoval.sourceSafe")).toBeTruthy();
            expect(input.workspaceCleanupPreview).not.toHaveBeenCalled();
            expect(screen.queryByRole("switch")).toBeNull();
            await userEvent
                .setup()
                .click(screen.getByRole("button", { name: "workspaceRemoval.remove" }));
            await waitFor(() => expect(input.onClose).toHaveBeenCalledOnce());
            expect(input.onRemove).toHaveBeenCalledOnce();
        },
    );

    it("loads concrete targets and retained directories, requiring explicit danger confirmation", async () => {
        const pending = deferred<WorkspaceCleanupResult>();
        const request = vi.fn().mockReturnValue(pending.promise);
        const input = setup({
            cleanup: true,
            client: { workspaceCleanupPreview: request } as unknown as TacoClient,
        });
        const user = userEvent.setup();
        const remove = screen.getByRole("button", {
            name: "workspaceRemoval.confirmRemoveAndClean",
        });
        expect(screen.getByRole("status").textContent).toContain("workspaceRemoval.loading");
        expect((remove as HTMLButtonElement).disabled).toBe(true);
        expect(request).toHaveBeenCalledWith({ cwd: asWorkspaceId(input.cwd) });
        await act(async () => pending.resolve(preview));
        for (const path of preview.removed) {
            expect(screen.getByText(path)).toBeTruthy();
        }
        const retained = screen.getByRole("region", { name: "workspaceRemoval.retained" });
        expect(within(retained).getByText(preview.skipped[0].path)).toBeTruthy();
        expect(within(retained).getByText("source directory")).toBeTruthy();
        expect((remove as HTMLButtonElement).disabled).toBe(true);
        await user.click(screen.getByRole("switch", { name: "workspaceRemoval.confirmCleanup" }));
        expect((remove as HTMLButtonElement).disabled).toBe(false);
        expect(remove.classList.contains("ui-btn--danger")).toBe(true);
        await user.click(remove);
        await waitFor(() => expect(input.onClose).toHaveBeenCalledOnce());
    });

    it("names the IM cleanup as permanent conversation deletion", async () => {
        setup({ cwd: makeImCwd("wecom", "peer", "chat"), cleanup: true });
        expect(screen.getByRole("dialog", { name: "workspaceRemoval.deleteImTitle" })).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "workspaceRemoval.confirmDeleteIm" }),
        ).toBeTruthy();
        expect(screen.getByText("workspaceRemoval.cleanupImHint")).toBeTruthy();
        await screen.findByText(preview.removed[0]);
    });

    it("keeps preview errors recoverable and blocks removal until retry succeeds", async () => {
        const request = vi
            .fn()
            .mockRejectedValueOnce(new Error("preview offline"))
            .mockResolvedValue(preview);
        const input = setup({
            cleanup: true,
            client: { workspaceCleanupPreview: request } as unknown as TacoClient,
        });
        expect(await screen.findByText("preview offline")).toBeTruthy();
        expect(
            (
                screen.getByRole("button", {
                    name: "workspaceRemoval.confirmRemoveAndClean",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "workspaceRemoval.retryPreview" }));
        expect(await screen.findByText(preview.removed[0])).toBeTruthy();
        expect(request).toHaveBeenCalledTimes(2);
        expect(input.onRemove).not.toHaveBeenCalled();
    });

    it("shows per-path preview failures and permits a new preview", async () => {
        const request = vi.fn().mockResolvedValue({
            ...preview,
            failed: [{ path: "/data/taco/private", error: "permission denied" }],
        });
        setup({
            cleanup: true,
            client: { workspaceCleanupPreview: request } as unknown as TacoClient,
        });
        expect(await screen.findByText("permission denied")).toBeTruthy();
        expect(screen.getByText("/data/taco/private")).toBeTruthy();
        expect(screen.getByRole("button", { name: "workspaceRemoval.retryPreview" })).toBeTruthy();
        expect(
            (
                screen.getByRole("button", {
                    name: "workspaceRemoval.confirmRemoveAndClean",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
    });

    it("blocks Escape, scrim, cancel and repeated confirmation while removal is busy", async () => {
        const pending = deferred<undefined>();
        const input = setup({ onRemove: vi.fn().mockReturnValue(pending.promise) });
        const user = userEvent.setup();
        const remove = screen.getByRole("button", { name: "workspaceRemoval.remove" });
        await user.click(remove);
        expect((remove as HTMLButtonElement).disabled).toBe(true);
        expect(
            (screen.getByRole("button", { name: "workspaceRemoval.cancel" }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        await user.keyboard("{Escape}");
        const overlay = document.querySelector(".ui-modal-backdrop");
        expect(overlay).toBeTruthy();
        await user.click(overlay as HTMLElement);
        await user.click(remove);
        expect(input.onClose).not.toHaveBeenCalled();
        expect(input.onRemove).toHaveBeenCalledOnce();
        await act(async () => pending.resolve(undefined));
        expect(input.onClose).toHaveBeenCalledOnce();
    });

    it("requires a fresh preview and renewed confirmation after partial cleanup", async () => {
        const result: WorkspaceCleanupResult = {
            removed: ["/data/taco/deleted"],
            skipped: [{ path: "/repo/project", reason: "source directory" }],
            failed: [{ path: "/data/taco/locked", error: "file locked" }],
        };
        const onRemove = vi
            .fn()
            .mockResolvedValueOnce(result)
            .mockResolvedValueOnce({ ...result, failed: [] });
        const input = setup({ cleanup: true, onRemove });
        const user = userEvent.setup();
        await screen.findByText(preview.removed[0]);
        await user.click(screen.getByRole("switch"));
        await user.click(
            screen.getByRole("button", { name: "workspaceRemoval.confirmRemoveAndClean" }),
        );
        expect(await screen.findByText("file locked")).toBeTruthy();
        expect(screen.getByText("/data/taco/deleted")).toBeTruthy();
        expect(screen.getByText("workspaceRemoval.removedTargets")).toBeTruthy();
        expect(input.onClose).not.toHaveBeenCalled();
        expect(
            (
                screen.getByRole("button", {
                    name: "workspaceRemoval.confirmRemoveAndClean",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(screen.queryByRole("switch")).toBeNull();
        const refreshed = deferred<WorkspaceCleanupResult>();
        input.workspaceCleanupPreview.mockReturnValueOnce(refreshed.promise);
        await user.click(screen.getByRole("button", { name: "workspaceRemoval.retryPreview" }));
        expect(screen.queryByText("/data/taco/deleted")).toBeNull();
        expect(screen.getByRole("status").textContent).toContain("workspaceRemoval.loading");
        expect(
            (
                screen.getByRole("button", {
                    name: "workspaceRemoval.confirmRemoveAndClean",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        expect(input.onRemove).toHaveBeenCalledTimes(1);
        await act(async () => refreshed.resolve({ ...preview, removed: ["/data/taco/remaining"] }));
        expect(screen.getByText("/data/taco/remaining")).toBeTruthy();
        expect(screen.queryByText(preview.removed[0])).toBeNull();
        expect(
            (
                screen.getByRole("button", {
                    name: "workspaceRemoval.confirmRemoveAndClean",
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(true);
        await user.click(screen.getByRole("switch"));
        await user.click(
            screen.getByRole("button", { name: "workspaceRemoval.confirmRemoveAndClean" }),
        );
        await waitFor(() => expect(input.onClose).toHaveBeenCalledOnce());
    });

    it("reports a parent error and keeps the dialog open for retry", async () => {
        const input = setup({
            onRemove: vi
                .fn()
                .mockRejectedValueOnce(new Error("cleanup partially failed"))
                .mockResolvedValueOnce(undefined),
        });
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "workspaceRemoval.remove" }));
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByText("cleanup partially failed")).toBeTruthy();
        expect(input.onClose).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "workspaceRemoval.remove" }));
        await waitFor(() => expect(input.onClose).toHaveBeenCalledOnce());
    });

    it("portals with a named dialog, focuses cancel and restores focus on dismissal", async () => {
        const user = userEvent.setup();
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();
        const input = setup();
        expect(screen.getByRole("dialog", { name: "workspaceRemoval.title" }).parentElement).toBe(
            document.body,
        );
        await waitFor(() =>
            expect(document.activeElement).toBe(
                screen.getByRole("button", { name: "workspaceRemoval.cancel" }),
            ),
        );
        await user.keyboard("{Escape}");
        expect(input.onClose).toHaveBeenCalledOnce();
        cleanup();
        await waitFor(() => expect(document.activeElement).toBe(opener));
        opener.remove();
    });
});
