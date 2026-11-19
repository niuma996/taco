import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { SidecarServer } from "../../src/server/server.ts";
import { InMemoryTransport } from "../_helpers/inMemoryTransport.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

useTempTacoHome("worktree-lifecycle");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
async function fixture(
    run: (root: string, server: SidecarServer, transport: InMemoryTransport) => Promise<void>,
) {
    const temp = await mkdtemp(join(tmpdir(), "taco-worktree-life-"));
    const root = await realpath(temp);
    const transport = new InMemoryTransport();
    const server = new SidecarServer({ providerKeyStore: new ProviderKeyStore({}), transport });
    try {
        git(root, "init", "-b", "main");
        git(
            root,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        await server.start(transport, []);
        await run(root, server, transport);
    } finally {
        await server.stop();
        await rm(temp, { recursive: true, force: true });
    }
}
async function create(server: SidecarServer, root: string, name = "feature") {
    const result = await server.dispatchRpc({
        id: `create-${name}`,
        method: "worktree.create",
        params: { workspace: root, name, base: "head" },
    });
    assert.ok(result.ok, JSON.stringify(result));
    return result.result as { path: string; branch: string };
}

test("worktree RPCs create managed inventory and remove clean trees while preserving branches", async () => {
    await fixture(async (root, server, transport) => {
        const created = await create(server, root);
        const list = await server.dispatchRpc({
            id: "inventory",
            method: "worktree.list",
            params: { workspace: root },
        });
        assert.ok(list.ok);
        assert.equal(
            (list.result as { worktrees: { path: string; managed: boolean }[] }).worktrees.find(
                (entry) => entry.path === created.path,
            )?.managed,
            true,
        );
        const removed = await server.dispatchRpc({
            id: "remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.ok(removed.ok, JSON.stringify(removed));
        await assert.rejects(access(created.path));
        assert.equal(git(root, "rev-parse", created.branch).trim().length, 40);
        const events = transport.sent.filter(
            (frame) => "method" in frame && frame.method === "worktree.changed",
        );
        assert.equal(events.length, 2);
        assert.equal(server.workspaceIds().length, 0);
    });
});

test("worktree runtime shares project memory and keeps sessions and checkpoints independent", async () => {
    await fixture(async (root, server, transport) => {
        const created = await create(server, root);
        const main = await server.ensureWorkspace(asWorkspaceId(root));
        const linked = await server.ensureWorkspace(asWorkspaceId(created.path));
        assert.equal(linked.scope.projectRoot, root);
        assert.equal(linked.resourceOwners.memory, root);
        assert.equal(main.memoryStore, linked.memoryStore);
        assert.notEqual(main.checkpointStore, linked.checkpointStore);
        assert.equal(linked.sessionCwd, created.path);
        await linked.memoryStore.appendEntry({
            id: "shared-note",
            name: "Shared",
            description: "Shared",
            type: "project",
            content: "Shared across checkouts",
            createdAt: new Date().toISOString(),
        });
        assert.equal(main.memoryStore.getTopic("shared-note")?.content, "Shared across checkouts");
        assert.ok(
            transport.sent.some(
                (frame) =>
                    "method" in frame &&
                    frame.method === "memory.changed" &&
                    frame.workspace === root,
            ),
        );
        assert.ok(
            transport.sent.some(
                (frame) =>
                    "method" in frame &&
                    frame.method === "memory.changed" &&
                    frame.workspace === created.path,
            ),
        );
        const clean = await server.cleanupWorkspace(asWorkspaceId(root), true);
        assert.ok(clean.skipped.some((entry) => entry.path === main.memoryStore.topicDir));
        assert.ok(main.memoryStore.topicDir);
        assert.ok(!clean.removed.includes(main.memoryStore.topicDir));
        await server.disposeWorkspace(asWorkspaceId(root));
        assert.equal(
            linked.memoryStore.getTopic("shared-note")?.content,
            "Shared across checkouts",
        );
    });
});

test("worktree removal rejects an attached session, dirty tree, external tree and main checkout", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root);
        const session = await server.dispatchRpc({
            id: "session",
            method: "session.create",
            params: { workspace: created.path },
        });
        assert.ok(session.ok, JSON.stringify(session));
        const attachedSession = await server.dispatchRpc({
            id: "attach",
            method: "session.attach",
            params: {
                workspace: created.path,
                sessionId: (session.result as { sessionId: string }).sessionId,
            },
        });
        assert.ok(attachedSession.ok, JSON.stringify(attachedSession));
        const attached = await server.dispatchRpc({
            id: "attached-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.equal(attached.ok, false);
        await access(created.path);
        const external = join(root, "external");
        git(root, "worktree", "add", "--detach", external, "HEAD");
        for (const path of [root, external]) {
            const result = await server.dispatchRpc({
                id: `remove-${path}`,
                method: "worktree.remove",
                params: { workspace: root, path },
            });
            assert.equal(result.ok, false);
            await access(path);
        }
        const dirty = await create(server, root, "dirty");
        await writeFile(join(dirty.path, "important.txt"), "keep");
        const refusal = await server.dispatchRpc({
            id: "dirty-remove",
            method: "worktree.remove",
            params: { workspace: root, path: dirty.path },
        });
        assert.equal(refusal.ok, false);
        assert.equal(await readFile(join(dirty.path, "important.txt"), "utf8"), "keep");
    });
});

test("worktree removal preserves detached conversation history and shared memory", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root, "history");
        const linked = await server.ensureWorkspace(asWorkspaceId(created.path));
        const session = await server.dispatchRpc({
            id: "history-session",
            method: "session.create",
            params: { workspace: created.path },
        });
        assert.ok(session.ok, JSON.stringify(session));
        const { filePath } = session.result as { filePath: string };
        await linked.memoryStore.appendEntry({
            id: "persistent-note",
            name: "Persistent",
            description: "Persistent",
            type: "project",
            content: "Retain after checkout removal",
            createdAt: new Date().toISOString(),
        });
        const removed = await server.dispatchRpc({
            id: "history-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.ok(removed.ok, JSON.stringify(removed));
        await access(filePath);
        assert.equal(
            linked.memoryStore.getTopic("persistent-note")?.content,
            "Retain after checkout removal",
        );
        const history = await server.dispatchRpc({
            id: "history-list",
            method: "session.list",
            params: { workspace: created.path, full: true },
        });
        assert.ok(history.ok, JSON.stringify(history));
        assert.equal((history.result as { sessions: unknown[] }).sessions.length, 1);
        const reopened = await server.ensureWorkspace(asWorkspaceId(created.path));
        assert.equal(reopened.scope.projectRoot, root);
        await assert.rejects(access(created.path));
        assert.equal(
            reopened.memoryStore.getTopic("persistent-note")?.content,
            "Retain after checkout removal",
        );
    });
});

test("worktree removal rejects persisted work targeting a child directory without a runtime", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root, "queued");
        const child = join(created.path, "src");
        await import("node:fs/promises").then(({ mkdir }) => mkdir(child));
        await server.work.store.createIfAbsent({
            schemaVersion: 1,
            workId: "w-tree-child",
            revision: 0,
            kind: "subagent",
            title: "Protected work",
            sourceEventId: "subagent:p:c",
            parentSessionId: "p",
            childSessionId: "c",
            agentType: "explorer",
            status: "running",
            ownerInstanceId: "old-instance",
            createdAt: 1,
            updatedAt: 1,
            workspace: child,
            attempt: { attemptId: "a-1", startedAt: 1 },
        });
        const result = await server.dispatchRpc({
            id: "queued-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.equal(result.ok, false);
        await access(created.path);
    });
});

test("memory mutation reaches IM consumers inheriting a worktree source and stops after revocation", async () => {
    await fixture(async (root, server, transport) => {
        const created = await create(server, root, "inherited");
        const local = await server.ensureWorkspace(asWorkspaceId(created.path));
        const im = asWorkspaceId("im://inherit-tree/peer/chat");
        await server.associations.set({ scope: "workspace", id: im }, [created.path]);
        await server.ensureWorkspace(im);
        transport.sent.length = 0;
        await local.memoryStore.appendEntry({
            id: "inherit-note",
            name: "Inherited",
            description: "Inherited",
            type: "project",
            content: "Shared source",
            createdAt: new Date().toISOString(),
        });
        await transport.waitForPushCount(2, 10000);
        assert.ok(
            transport.sent.some(
                (frame) =>
                    "method" in frame &&
                    frame.method === "memory.changed" &&
                    frame.workspace === im,
            ),
        );
        const listing = await server.dispatchRpc({
            id: "im-list",
            method: "memory.list",
            params: { workspace: im },
        });
        assert.ok(listing.ok, JSON.stringify(listing));
        assert.match(JSON.stringify(listing.result), /inherit-note/);
        await server.associations.set({ scope: "workspace", id: im }, []);
        transport.sent.length = 0;
        await local.memoryStore.updateTopic("inherit-note", "Updated source");
        assert.ok(
            !transport.sent.some(
                (frame) =>
                    "method" in frame &&
                    frame.method === "memory.changed" &&
                    frame.workspace === im,
            ),
        );
    });
});

test("opening a preexisting linked checkout imports its legacy topics without overwriting project memory", async () => {
    await fixture(async (root, server) => {
        const external = join(root, "old-linked");
        git(root, "worktree", "add", "--detach", external, "HEAD");
        const { LocalMemoryStore } = await import("../../src/memory/local/store.ts");
        const legacy = new LocalMemoryStore();
        legacy.initialize(external);
        await legacy.appendEntry({
            id: "legacy-note",
            name: "Old note",
            description: "Old note",
            type: "project",
            content: "Existing worktree context",
            createdAt: new Date().toISOString(),
        });
        const linked = await server.ensureWorkspace(asWorkspaceId(external));
        assert.equal(linked.resourceOwners.memory, root);
        assert.equal(
            linked.memoryStore.getTopic("legacy-note")?.content,
            "Existing worktree context",
        );
        assert.equal(legacy.getTopic("legacy-note")?.content, "Existing worktree context");
    });
});

test("removed worktree history cannot start another execution or recreate its directory", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root, "unavailable");
        const session = await server.dispatchRpc({
            id: "unavailable-session",
            method: "session.create",
            params: { workspace: created.path },
        });
        assert.ok(session.ok, JSON.stringify(session));
        const sessionId = (session.result as { sessionId: string }).sessionId;
        const removed = await server.dispatchRpc({
            id: "unavailable-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.ok(removed.ok, JSON.stringify(removed));
        const attach = await server.dispatchRpc({
            id: "unavailable-attach",
            method: "session.attach",
            params: { workspace: created.path, sessionId },
        });
        assert.equal(attach.ok, false);
        if (!attach.ok) assert.equal(attach.error.code, "invalid_state");
        await assert.rejects(access(created.path));
    });
});

test("cold persisted IM work protects its custom worktree execution directory", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root, "cold-im");
        const im = "im://cold-im-tree/peer/chat";
        await server.setImChannelDefault("cold-im-tree", {
            executionDir: { mode: "custom", path: created.path },
        });
        await server.work.store.createIfAbsent({
            schemaVersion: 1,
            workId: "w-cold-im-tree",
            revision: 0,
            kind: "subagent",
            title: "Cold IM work",
            sourceEventId: "cold-im-source",
            parentSessionId: "p",
            childSessionId: "c",
            agentType: "explorer",
            status: "running",
            ownerInstanceId: "old-instance",
            createdAt: 1,
            updatedAt: 1,
            workspace: im,
            attempt: { attemptId: "a-1", startedAt: 1 },
        });
        assert.ok(!server.workspaceIds().includes(asWorkspaceId(im)));
        const result = await server.dispatchRpc({
            id: "cold-im-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.equal(result.ok, false);
        await access(created.path);
    });
});

test("removal protects persisted work running in the main checkout containing the worktree", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root, "ancestor-work");
        await server.work.store.createIfAbsent({
            schemaVersion: 1,
            workId: "w-ancestor-work",
            revision: 0,
            kind: "subagent",
            title: "Parent checkout work",
            sourceEventId: "ancestor-work",
            parentSessionId: "p",
            childSessionId: "c",
            agentType: "explorer",
            status: "running",
            ownerInstanceId: "old",
            createdAt: 1,
            updatedAt: 1,
            workspace: root,
            attempt: { attemptId: "a-1", startedAt: 1 },
        });
        const result = await server.dispatchRpc({
            id: "ancestor-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.equal(result.ok, false);
        await access(created.path);
    });
});

test("worktree removal retries a completed deletion and notifies the owning project", async () => {
    await fixture(async (root, server, transport) => {
        const created = await create(server, root, "retry-removal");
        const params = { workspace: root, path: created.path };
        for (const id of ["first-remove", "retry-remove"]) {
            const result = await server.dispatchRpc({ id, method: "worktree.remove", params });
            assert.ok(result.ok, JSON.stringify(result));
        }
        const changed = transport.sent.filter(
            (frame) => "method" in frame && frame.method === "worktree.changed",
        );
        assert.ok(
            changed.every(
                (frame) =>
                    "params" in frame &&
                    (frame.params as { projectRoot: string }).projectRoot === root,
            ),
        );
    });
});

test("removal protects an attached ancestor workspace", async () => {
    await fixture(async (root, server) => {
        const created = await create(server, root, "ancestor-session");
        const session = await server.dispatchRpc({
            id: "main-session",
            method: "session.create",
            params: { workspace: root },
        });
        assert.ok(session.ok, JSON.stringify(session));
        const sessionId = (session.result as { sessionId: string }).sessionId;
        const attach = await server.dispatchRpc({
            id: "main-attach",
            method: "session.attach",
            params: { workspace: root, sessionId },
        });
        assert.ok(attach.ok, JSON.stringify(attach));
        const result = await server.dispatchRpc({
            id: "ancestor-attached-remove",
            method: "worktree.remove",
            params: { workspace: root, path: created.path },
        });
        assert.equal(result.ok, false);
        await access(created.path);
    });
});

test("creation from a separate Git directory reports its committed result and emits one notification", async () => {
    await fixture(async (root, server, transport) => {
        const { mkdir } = await import("node:fs/promises");
        const cwd = join(root, "separate-checkout"),
            metadata = join(root, "metadata");
        await mkdir(cwd);
        git(cwd, "init", "--separate-git-dir", metadata);
        git(
            cwd,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        const result = await create(server, cwd, "separate-tree");
        await access(result.path);
        const events = transport.sent.filter(
            (frame) => "method" in frame && frame.method === "worktree.changed",
        );
        assert.equal(events.length, 1);
        assert.equal((events[0] as { params: { projectRoot: string } }).params.projectRoot, cwd);
    });
});
