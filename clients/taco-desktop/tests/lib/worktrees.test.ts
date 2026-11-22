import assert from "node:assert/strict";
import { test } from "node:test";
import type { GitInspectResult, GitRepositoryInfo } from "@taco-ai/protocol";

function repository(overrides: Partial<GitRepositoryInfo> = {}): GitRepositoryInfo {
    return {
        checkoutRoot: "/repo/main",
        gitDir: "/repo/main/.git",
        commonDir: "/repo/main/.git",
        isBare: false,
        headOid: "abc",
        branch: "main",
        ...overrides,
    };
}

test("identifies linked worktrees from canonical Git directories", async () => {
    const { isLinkedWorktree } = await import("../../src/lib/worktrees.ts");
    const inspect = (repo: GitRepositoryInfo): GitInspectResult => ({
        status: "repository",
        repository: repo,
        changes: [],
    });

    assert.equal(isLinkedWorktree?.(inspect(repository())), false);
    assert.equal(
        isLinkedWorktree?.(
            inspect(
                repository({
                    checkoutRoot: "/repo/main/.taco/worktrees/settings-visual-refinement",
                    gitDir: "/repo/main/.git/worktrees/settings-visual-refinement",
                }),
            ),
        ),
        true,
    );
    assert.equal(
        isLinkedWorktree?.(
            inspect(
                repository({
                    gitDir: "/metadata/modules/example",
                    commonDir: "/metadata/modules/example",
                }),
            ),
        ),
        false,
    );
    assert.equal(isLinkedWorktree?.({ status: "not_repository" }), false);
    assert.equal(isLinkedWorktree?.({ status: "missing" }), false);
});
