import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    buildWorktreeGuidance,
    worktreeCapabilityFromInventory,
} from "../../src/worktree/capability.ts";

describe("worktree turn capability", () => {
    it("requires a non-bare repository with a commit", () => {
        for (const inventory of [
            { status: "missing" },
            { status: "not_repository" },
            { status: "repository", repository: { isBare: true, headOid: "abc" } },
            { status: "repository", repository: { isBare: false, headOid: null } },
        ])
            assert.equal(worktreeCapabilityFromInventory(inventory), false);
        assert.equal(
            worktreeCapabilityFromInventory({
                status: "repository",
                repository: { isBare: false, headOid: "abc" },
            }),
            true,
        );
    });

    it("drives isolation only for substantial writes and protects existing worktrees", () => {
        const guidance = buildWorktreeGuidance();
        assert.match(guidance, /complex|cross-module/i);
        assert.match(guidance, /high-risk/i);
        assert.match(guidance, /parallel/i);
        assert.match(guidance, /read-only|questions/i);
        assert.match(guidance, /already in a Git worktree/i);
        assert.match(guidance, /uncommitted changes are not copied/i);
        assert.match(guidance, /worktreeStart/);
    });
});
