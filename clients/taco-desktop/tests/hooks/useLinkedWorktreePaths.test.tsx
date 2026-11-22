import type { GitInspectResult } from "@taco-ai/protocol";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(cleanup);

describe("useLinkedWorktreePaths", () => {
    it("derives hidden paths from each workspace's own Git identity", async () => {
        const { useLinkedWorktreePaths } = await import("../../src/hooks/useGitWorkspace");
        expect(typeof useLinkedWorktreePaths).toBe("function");

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
});
