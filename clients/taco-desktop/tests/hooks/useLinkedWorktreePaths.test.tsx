import type { GitInspectResult } from "@taco-ai/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(cleanup);

describe("useLinkedWorktreePaths", () => {
    it("derives hidden paths from each workspace's own Git identity", async () => {
        const { useLinkedWorktreePaths } = await import("../../src/hooks/useGitWorkspace");

        const main: GitInspectResult = {
            status: "repository",
            repository: {
                checkoutRoot: "/repo/main",
                gitDir: "/repo/main/.git",
                commonDir: "/repo/main/.git",
                isBare: false,
                headOid: "abc",
                branch: "main",
            },
            changes: [],
        };
        const linked: GitInspectResult = {
            ...main,
            repository: {
                ...main.repository,
                checkoutRoot: "/repo/main/.taco/worktrees/settings-visual-refinement",
                gitDir: "/repo/main/.git/worktrees/settings-visual-refinement",
            },
        };
        const results: Record<string, GitInspectResult> = {
            "/repo/main": main,
            "/repo/main/.taco/worktrees/settings-visual-refinement": linked,
            "/repo/other": { status: "not_repository" },
        };
        const client = {
            gitInspect: vi.fn(({ workspace }: { workspace: string }) =>
                Promise.resolve(results[workspace] ?? { status: "not_repository" }),
            ),
        };
        const { wrapper } = queryWrapper();
        const view = renderHook(
            () =>
                useLinkedWorktreePaths(client, {
                    "/repo/main": {},
                    "/repo/main/.taco/worktrees/settings-visual-refinement": {},
                    "/repo/other": {},
                    "im://wecom/alice/chat": {},
                }),
            { wrapper },
        );

        await waitFor(() => expect(view.result.current.size).toBe(1));
        expect(
            view.result.current.has("/repo/main/.taco/worktrees/settings-visual-refinement"),
        ).toBe(true);
        expect(view.result.current.has("/repo/main")).toBe(false);
        expect(client.gitInspect).toHaveBeenCalledTimes(3);
        expect(client.gitInspect).not.toHaveBeenCalledWith({
            workspace: "im://wecom/alice/chat",
        });
    });

    it("retries a transient inspection failure instead of misclassifying the worktree", async () => {
        const { useLinkedWorktreePaths } = await import("../../src/hooks/useGitWorkspace");
        const treeCwd = "/repo/main/.taco/worktrees/settings-visual-refinement";
        const main: GitInspectResult = {
            status: "repository",
            repository: {
                checkoutRoot: "/repo/main",
                gitDir: "/repo/main/.git",
                commonDir: "/repo/main/.git",
                isBare: false,
                headOid: "abc",
                branch: "main",
            },
            changes: [],
        };
        const linked: GitInspectResult = {
            ...main,
            repository: {
                ...main.repository,
                checkoutRoot: treeCwd,
                gitDir: "/repo/main/.git/worktrees/settings-visual-refinement",
            },
        };
        let attempts = 0;
        const client = {
            gitInspect: vi.fn(({ workspace }: { workspace: string }) => {
                if (workspace !== treeCwd) return Promise.resolve(main);
                attempts += 1;
                return attempts === 1
                    ? Promise.reject(new Error("sidecar not ready"))
                    : Promise.resolve(linked);
            }),
        };
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
        });
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );
        const view = renderHook(
            () => useLinkedWorktreePaths(client, { "/repo/main": {}, [treeCwd]: {} }),
            { wrapper },
        );

        await waitFor(() => expect(view.result.current.has(treeCwd)).toBe(true));
        expect(attempts).toBe(2);
    });
});
