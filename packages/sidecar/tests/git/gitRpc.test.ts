import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { getRegisteredMethod } from "../../src/server/methodRegistry.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("git-rpc");
test("Git inspection, initialization and worktree inventory route without constructing runtimes", async () => {
    const root = await mkdtemp(join(tmpdir(), "taco-git-rpc-"));
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    try {
        const before = await server.dispatchRpc({
            id: "probe",
            method: "git.inspect",
            params: { workspace: root },
        });
        assert.ok(before.ok, JSON.stringify(before));
        if (before.ok) assert.deepEqual(before.result, { status: "not_repository" });
        const created = await server.dispatchRpc({
            id: "init",
            commandId: "initialize-selected",
            method: "git.init",
            params: { workspace: root },
        });
        assert.ok(created.ok, JSON.stringify(created));
        const listing = await server.dispatchRpc({
            id: "list",
            method: "worktree.list",
            params: { workspace: root },
        });
        assert.ok(listing.ok, JSON.stringify(listing));
        assert.deepEqual(server.workspaceIds(), []);
        for (const method of ["git.inspect", "git.init", "worktree.list"]) {
            assert.equal(getRegisteredMethod(method)?.ensureWorkspace, false);
            const invalid = await server.dispatchRpc({
                id: `im-${method}`,
                method,
                params: { workspace: "im://channel/peer/chat" },
            });
            assert.equal(invalid.ok, false);
            if (!invalid.ok) assert.equal(invalid.error.code, "invalid_params");
        }
        assert.equal(getRegisteredMethod("git.init")?.options.command, true);
    } finally {
        await server.stop();
        await rm(root, { recursive: true, force: true });
    }
});

test("worktree cleanup rejects invalid thresholds at the RPC boundary", async () => {
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    try {
        for (const params of [
            { workspace: "/project", maxAgeDays: 0 },
            { workspace: "/project", maxCount: 0 },
            { workspace: "/project", maxCount: 10001 },
        ]) {
            const result = await server.dispatchRpc({
                id: "invalid-cleanup",
                method: "worktree.cleanup",
                params,
            });
            assert.equal(result.ok, false);
            if (!result.ok) assert.equal(result.error.code, "invalid_params");
        }
    } finally {
        await server.stop();
    }
});
