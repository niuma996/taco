import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { NullTransport } from "../../src/server/nullTransport.ts";
import { SidecarServer } from "../../src/server/server.ts";
import type { WorkspaceCleanupGate } from "../../src/server/workspaceCleanupGate.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("worktree-admission");
test("cold IM requests honor the cleanup gate of their custom execution directory", async () => {
    const temp = await mkdtemp(join(tmpdir(), "taco-tree-admission-"));
    const target = await realpath(temp);
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}) });
    await server.start(new NullTransport(), []);
    const im = asWorkspaceId("im://worktree-admission/peer/chat");
    try {
        await server.setImChannelDefault("worktree-admission", {
            executionDir: { mode: "custom", path: target },
        });
        // Exercise the real server's gate through a controlled cleanup callback.
        const gate = (server as unknown as { cleanupGate: WorkspaceCleanupGate }).cleanupGate;
        await gate.cleanup(asWorkspaceId(target), async () => {
            const request = await server.dispatchRpc({
                id: "cold-im",
                method: "workspace.ensure",
                params: { cwd: im },
            });
            assert.equal(request.ok, false);
            if (!request.ok) assert.equal(request.error.code, "invalid_state");
        });
        assert.deepEqual(server.workspaceIds(), []);
    } finally {
        await server.stop();
        await rm(temp, { recursive: true, force: true });
    }
});
