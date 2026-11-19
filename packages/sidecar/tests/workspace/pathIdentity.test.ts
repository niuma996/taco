import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    containsWorkspacePath,
    workspaceAccessPath,
    workspacePathsOverlap,
} from "../../src/workspace/pathIdentity.ts";

test("access identity preserves missing descendants beneath symlinked ancestors", async () => {
    const temp = await mkdtemp(join(tmpdir(), "taco-path-identity-"));
    try {
        const root = await realpath(temp);
        const actual = join(root, "actual"),
            alias = join(root, "alias");
        await mkdir(actual);
        await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
        assert.equal(
            workspaceAccessPath(join(alias, "missing", "child")),
            join(actual, "missing", "child"),
        );
        assert.equal(containsWorkspacePath(actual, join(actual, "..literal")), true);
        assert.equal(workspacePathsOverlap(actual, join(actual, "..", "sibling")), false);
        assert.equal(workspaceAccessPath("im://channel/peer/chat"), "im://channel/peer/chat");
        assert.equal(workspacePathsOverlap("im://channel/peer/chat", actual), false);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
});
