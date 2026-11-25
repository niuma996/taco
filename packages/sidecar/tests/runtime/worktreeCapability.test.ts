import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { worktreeCapabilityFromInventory } from "../../src/worktree/capability.ts";

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
});
