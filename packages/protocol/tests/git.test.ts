import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import * as protocol from "../src/index.ts";

test("worktree management uses the 2.24 contract and distinct process pushes", () => {
    assert.deepEqual(protocol.SIDECAR_PROTOCOL_VERSION, { major: 2, minor: 24 });
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 20 }), false);
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 21 }), false);
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 22 }), false);
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 23 }), false);
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 24 }), true);
    assert.equal(protocol.isCompatibleClientProtocol({ major: 2, minor: 21 }), true);
    assert.equal(protocol.PushMethods.WorktreeChanged, "worktree.changed");
    assert.equal(protocol.PushMethods.WorktreeHandoff, "worktree.handoff");
});

test("Git schemas are exported and shared with workspace-routed contract rows", () => {
    const schemas = {
        gitInspect: protocol.gitInspectSchema,
        gitInit: protocol.gitInitSchema,
        worktreeList: protocol.worktreeListSchema,
        worktreeCreate: protocol.worktreeCreateSchema,
        worktreeRemove: protocol.worktreeRemoveSchema,
        worktreeCleanup: protocol.worktreeCleanupSchema,
    };
    for (const key of Object.keys(schemas) as (keyof typeof schemas)[]) {
        assert.equal(protocol.rpcSchemas[key], schemas[key]);
        assert.equal(protocol.rpcContract[key].scope, "workspace");
        assert.equal(protocol.rpcContract[key].routeParam, "workspace");
    }
});

test("create accepts optional head/default base and rejects malformed or extra params", () => {
    const params = { workspace: "/project", name: "feature" };
    for (const base of [undefined, "head", "default"]) {
        assert.equal(Check(protocol.worktreeCreateSchema, { ...params, base }), true);
    }
    for (const invalid of [
        { ...params, base: "main" },
        { ...params, name: "" },
        { ...params, name: "a".repeat(81) },
        { ...params, force: true },
        { name: "feature" },
        { ...params, workspace: 42 },
    ])
        assert.equal(Check(protocol.worktreeCreateSchema, invalid), false);
});

test("remove requires workspace and path without force or branch options", () => {
    const params = { workspace: "/project", path: "/worktrees/feature" };
    assert.equal(Check(protocol.worktreeRemoveSchema, params), true);
    for (const invalid of [
        { workspace: params.workspace },
        { path: params.path },
        { ...params, path: "" },
        { ...params, force: true },
        { ...params, branch: "feature" },
    ])
        assert.equal(Check(protocol.worktreeRemoveSchema, invalid), false);
});

test("cleanup accepts bounded positive thresholds only", () => {
    assert.equal(Check(protocol.worktreeCleanupSchema, { workspace: "/project" }), true);
    assert.equal(
        Check(protocol.worktreeCleanupSchema, {
            workspace: "/project",
            maxAgeDays: 14,
            maxCount: 15,
        }),
        true,
    );
    for (const invalid of [
        { workspace: "/project", maxAgeDays: 0 },
        { workspace: "/project", maxCount: 0 },
        { workspace: "/project", maxAgeDays: 1.5 },
        { workspace: "/project", maxCount: 10001 },
        { workspace: "/project", force: true },
    ])
        assert.equal(Check(protocol.worktreeCleanupSchema, invalid), false);
});
