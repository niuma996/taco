import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import * as protocol from "../src/index.ts";

test("worktree management uses the 2.22 contract and a distinct process push", () => {
    assert.deepEqual(protocol.SIDECAR_PROTOCOL_VERSION, { major: 2, minor: 22 });
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 20 }), false);
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 21 }), false);
    assert.equal(protocol.isCompatibleSidecarProtocol({ major: 2, minor: 22 }), true);
    assert.equal(protocol.isCompatibleClientProtocol({ major: 2, minor: 21 }), true);
    assert.equal(protocol.PushMethods.WorktreeChanged, "worktree.changed");
});

test("Git schemas are exported and shared with workspace-routed contract rows", () => {
    const schemas = {
        gitInspect: protocol.gitInspectSchema,
        gitInit: protocol.gitInitSchema,
        worktreeList: protocol.worktreeListSchema,
        worktreeCreate: protocol.worktreeCreateSchema,
        worktreeRemove: protocol.worktreeRemoveSchema,
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
