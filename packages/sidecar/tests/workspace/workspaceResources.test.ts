import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import * as scopeModule from "../../src/workspace/workspaceScope.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const root = useTempTacoHome("resource-owners");

test("resource owners preserve local storage, execution and routing identities", async () => {
    const { resolveWorkspaceResourceOwners } = await import(
        "../../src/workspace/workspaceResources.ts"
    );
    const scope = scopeModule.createWorkspaceScope(
        asWorkspaceId("/route/alias"),
        "/session",
        "/execution",
    );
    assert.deepEqual(resolveWorkspaceResourceOwners(scope), {
        memory: "/session",
        checkpoint: "/execution",
        configCwd: "/execution",
    });
});

test("worktree resources share project memory and configuration but keep execution checkpoints", async () => {
    const { resolveWorkspaceResourceOwners } = await import(
        "../../src/workspace/workspaceResources.ts"
    );
    const scope = scopeModule.createWorkspaceScope(
        asWorkspaceId("/repo/.taco/worktrees/feature"),
        "/repo/.taco/worktrees/feature",
        "/repo/.taco/worktrees/feature",
        "/repo",
    );
    assert.deepEqual(resolveWorkspaceResourceOwners(scope), {
        memory: "/repo",
        checkpoint: "/repo/.taco/worktrees/feature",
        configCwd: "/repo",
    });
});

test("IM memory identity remains private when storage and execution are shared", async () => {
    const { resolveWorkspaceResourceOwners } = await import(
        "../../src/workspace/workspaceResources.ts"
    );
    const a = scopeModule.createWorkspaceScope(
        asWorkspaceId("im://channel/peer/a"),
        "/scratch",
        "/execution",
    );
    const b = scopeModule.createWorkspaceScope(
        asWorkspaceId("im://channel/peer/b"),
        "/scratch",
        "/execution",
    );
    const owners = [a, b].map(resolveWorkspaceResourceOwners);
    assert.notEqual(owners[0].memory, owners[1].memory);
    assert.equal(owners[0].checkpoint, owners[1].checkpoint);
});

test("store factory preserves legacy partitions and disabled resource choices", async () => {
    const { createWorkspaceStores, resolveWorkspaceResourceOwners } = await import(
        "../../src/workspace/workspaceResources.ts"
    );
    const { memoryProjectDir, checkpointStoragePaths } = await import(
        "../../src/workspace/storagePaths.ts"
    );
    const owners = resolveWorkspaceResourceOwners(
        scopeModule.createWorkspaceScope(asWorkspaceId("/project")),
    );
    const stores = createWorkspaceStores(owners);
    assert.equal(stores.memory.topicDir, memoryProjectDir("/project"));
    const meta = await stores.checkpoint?.create({
        sessionId: "s",
        label: "before",
        paths: [join(root, "absent")],
    });
    const { readFile } = await import("node:fs/promises");
    const envelope = JSON.parse(
        await readFile(checkpointStoragePaths("/project").indexPath, "utf8"),
    );
    assert.equal(envelope.checkpoints[0].id, meta?.id);
    const disabled = createWorkspaceStores(owners, {
        memoryEnabled: false,
        checkpointsEnabled: false,
    });
    assert.equal(disabled.memory.enabled, false);
    assert.equal(disabled.checkpoint, undefined);
});

test("storage paths retain distinct historical memory and checkpoint hashing", async () => {
    const { memoryProjectDir, checkpointStoragePaths } = await import(
        "../../src/workspace/storagePaths.ts"
    );
    const home = join(root, "lexical", "..", "storage");
    const identity = "D:\\project\\tree";
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    assert.equal(
        memoryProjectDir(identity, home),
        join(home, "memory", "projects", hash("D:/project/tree")),
    );
    assert.equal(
        checkpointStoragePaths(identity, home).root,
        join(home, "checkpoints", hash(identity)),
    );
});
