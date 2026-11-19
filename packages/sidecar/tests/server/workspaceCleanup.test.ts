import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { asWorkspaceId, makeImCwd } from "@taco-ai/protocol";
import { ConversationRouter } from "../../src/channels/conversationRouter.ts";
import { chatPolicyKey } from "../../src/channels/imWorkspacePolicy.ts";
import { ImWorkspacePolicyStore } from "../../src/channels/imWorkspacePolicyStore.ts";
import { harnessContext } from "../../src/lib/harnessContext.ts";
import { NodeExecutionEnv } from "../../src/runtime/pi/node.ts";
import { JsonlSessionRepo } from "../../src/runtime/pi/values.ts";
import { WorkspaceCleanupService } from "../../src/server/workspaceCleanup.ts";
import { WorkspaceCleanupGate } from "../../src/server/workspaceCleanupGate.ts";
import { WorkspaceAssociationStore } from "../../src/workspace/associationStore.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("workspace-cleanup");
const projects = mkdtempSync(join(tmpdir(), "cleanup-projects-"));
after(() => rmSync(projects, { recursive: true, force: true }));
const hash = (key: string, length = 16) =>
    createHash("sha256").update(key).digest("hex").slice(0, length);
function put(path: string, content = "owned") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
}
async function fixture(name: string, im = false) {
    const base = join(home, name);
    const cwd = asWorkspaceId(im ? makeImCwd(name, "peer", "chat") : join(base, "project"));
    const root = im ? join(home, "sessions", "im", name) : join(base, "sessions");
    const sessionCwd = im ? join(root, "scratch") : cwd;
    mkdirSync(sessionCwd, { recursive: true });
    const repo = new JsonlSessionRepo({
        fileSystem: new NodeExecutionEnv({ cwd: sessionCwd }),
        sessionsRoot: root,
    });
    async function session(id: string, parentSessionId?: string) {
        const value = await repo.create({ id, cwd: sessionCwd, parentSessionId }, harnessContext);
        const path = value.metadata.path;
        await value.close(harnessContext);
        put(
            join(root, id, "tasks", "done.json"),
            JSON.stringify({ tasks: [{ status: "completed" }] }),
        );
        return path;
    }
    const policy = new ImWorkspacePolicyStore(home);
    const associations = new WorkspaceAssociationStore({ home });
    const router = await ConversationRouter.load(home);
    const service = new WorkspaceCleanupService({
        home,
        sessionsRoot: root,
        runtimes: () => [],
        router,
        policy,
        associations,
        hasActiveWork: async () => false,
        dispose: async () => {},
    });
    return { cwd, root, sessionCwd, session, service, router, policy, associations };
}

test("local preview is read-only; cleanup removes owned trees and preserves project, associations and global memory", async () => {
    const f = await fixture("local");
    const transcript = await f.session("parent");
    const child = await f.session("child", "parent");
    const source = put(join(f.cwd, "src", "main.ts"), "source");
    const associated = put(join(projects, "associated", "keep.txt"));
    await f.associations.set({ scope: "workspace", id: f.cwd }, [dirname(associated)]);
    const owned = [
        transcript,
        child,
        join(f.root, "parent"),
        join(f.root, "child"),
        put(join(home, "memory", "projects", hash(f.cwd), "note.md")),
        put(join(home, "checkpoints", hash(f.cwd), "index.json")),
        put(join(home, "staging", "attachments", hash(f.cwd, 32), "file")),
    ];
    const global = put(join(home, "memory", "MEMORY.md"), "global");
    const preview = await f.service.run(f.cwd, true);
    assert.ok(preview.removed.includes(transcript));
    assert.ok(preview.skipped.some((entry) => entry.path === f.cwd));
    assert.ok(preview.skipped.some((entry) => entry.path === dirname(associated)));
    for (const path of owned) assert.ok(existsSync(path));
    const result = await f.service.run(f.cwd, false);
    assert.deepEqual(result.failed, []);
    for (const path of owned) assert.equal(existsSync(path), false, path);
    for (const path of [source, associated, global]) assert.ok(existsSync(path), path);
    assert.deepEqual(f.associations.get({ scope: "workspace", id: f.cwd }), []);
});

test("cleanup accepts renamed JSONL transcripts supported by the repository", async () => {
    const f = await fixture("renamed-transcript");
    const original = await f.session("renamed-session");
    const transcript = join(dirname(original), "renamed.jsonl");
    renameSync(original, transcript);
    const probeOriginal = await f.session("delete-probe");
    const probePath = join(dirname(probeOriginal), "delete-probe.jsonl");
    renameSync(probeOriginal, probePath);
    const repo = new JsonlSessionRepo({
        fileSystem: new NodeExecutionEnv({ cwd: f.sessionCwd }),
        sessionsRoot: f.root,
    });
    const all = await repo.list({}, harnessContext);
    const meta = all.find((entry) => entry.id === "renamed-session");
    const probe = all.find((entry) => entry.id === "delete-probe");
    assert.ok(meta);
    assert.ok(probe);
    assert.equal(meta.path, transcript);
    const opened = await repo.open(meta, harnessContext);
    assert.equal(opened.metadata.id, "renamed-session");
    await opened.close(harnessContext);
    await repo.delete(probe, harnessContext);
    assert.equal(existsSync(probePath), false);

    const preview = await f.service.run(f.cwd, true);
    assert.deepEqual(preview.failed, []);
    assert.ok(preview.removed.includes(transcript));
    assert.ok(existsSync(transcript));
    const result = await f.service.run(f.cwd, false);
    assert.deepEqual(result.failed, []);
    assert.ok(result.removed.includes(transcript));
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(join(f.root, meta.id)), false);
});

test("duplicate transcript ids prevent every cleanup mutation", async () => {
    const f = await fixture("duplicate-transcript");
    const transcript = await f.session("duplicate-session");
    const duplicate = put(
        join(dirname(transcript), "duplicate.jsonl"),
        readFileSync(transcript, "utf8"),
    );
    for (const preview of [true, false]) {
        const result = await f.service.run(f.cwd, preview);
        assert.ok(
            result.failed.some((entry) => entry.path === transcript || entry.path === duplicate),
        );
        assert.deepEqual(result.removed, []);
        for (const path of [transcript, duplicate, join(f.root, "duplicate-session")])
            assert.ok(existsSync(path));
    }
});

test("transcript deletion never recursively removes a directory replacing the file", async () => {
    const f = await fixture("transcript-directory");
    const transcript = await f.session("directory-session");
    const nested = join(transcript, "keep.txt");
    const deleted: string[] = [];
    const service = new WorkspaceCleanupService({
        home,
        sessionsRoot: f.root,
        runtimes: () => [],
        policy: f.policy,
        associations: f.associations,
        hasActiveWork: async () => false,
        dispose: async () => {},
        beforeSessionDeleted: async () => {
            renameSync(transcript, `${transcript}.bak`);
            put(nested);
        },
        onSessionDeleted: async (_cwd, id) => {
            deleted.push(id);
        },
    });
    const result = await service.run(f.cwd, false);
    assert.ok(result.failed.some((entry) => entry.path === transcript));
    assert.ok(existsSync(nested));
    assert.ok(existsSync(`${transcript}.bak`));
    assert.deepEqual(deleted, []);
});

test("IM cleanup deletes only the exact route tree and chat records, retaining sibling session and shared/custom directories", async () => {
    const f = await fixture("im-exact", true);
    const transcript = await f.session("target");
    const child = await f.session("descendant", "target");
    const sibling = await f.session("sibling");
    const routing = join(home, "sessions", "im", "routing.json");
    put(
        routing,
        JSON.stringify({
            [f.cwd]: { sessionId: "target", lastUsedAt: 1 },
            [makeImCwd("im-exact", "peer", "other")]: { sessionId: "sibling", lastUsedAt: 2 },
        }),
    );
    const router = await ConversationRouter.load(home);
    const custom = put(join(projects, "custom-project", "keep.txt"));
    await f.policy.setChannelDefault("im-exact", { tools: { shell: "allow" } });
    await f.policy.setChatOverride(
        { channelId: "im-exact", peerId: "peer", chatId: "chat" },
        { executionDir: { mode: "custom", path: dirname(custom) } },
    );
    const scratch = put(
        join(
            f.root,
            "chats",
            chatPolicyKey({ channelId: "im-exact", peerId: "peer", chatId: "chat" }),
            "scratch",
            "owned.txt",
        ),
    );
    const service = new WorkspaceCleanupService({
        home,
        sessionsRoot: f.root,
        runtimes: () => [],
        router,
        policy: f.policy,
        associations: f.associations,
        hasActiveWork: async () => false,
        dispose: async () => {},
    });
    const result = await service.run(f.cwd, false);
    assert.deepEqual(result.failed, []);
    for (const path of [transcript, child, scratch]) assert.equal(existsSync(path), false);
    for (const path of [sibling, custom, f.sessionCwd]) assert.ok(existsSync(path));
    assert.equal(router.lookupByWorkspace(f.cwd), undefined);
    assert.equal(router.listAll("im-exact").length, 1);
    assert.equal(f.policy.readDocument("im-exact").default?.tools?.shell, "allow");
    assert.deepEqual(f.policy.readDocument("im-exact").chats, {});
});

test("queued work rejects before mutation", async () => {
    const f = await fixture("busy");
    const transcript = await f.session("busy-parent");
    const service = new WorkspaceCleanupService({
        home,
        sessionsRoot: f.root,
        runtimes: () => [],
        policy: f.policy,
        associations: f.associations,
        hasActiveWork: async () => true,
        dispose: async () => {
            throw new Error("must not dispose");
        },
    });
    await assert.rejects(() => service.run(f.cwd, false), /活动|任务/);
    assert.ok(existsSync(transcript));
});

test("symlinked auxiliary parent is reported and external files survive", async () => {
    const f = await fixture("symlink");
    await f.session("safe");
    const external = put(join(home, "external", "keep.txt"));
    symlinkSync(dirname(external), join(f.root, "safe", "outside"));
    const result = await f.service.run(f.cwd, false);
    assert.ok(existsSync(external));
    assert.equal(readFileSync(external, "utf8"), "owned");
    assert.deepEqual(result.failed, []);
});

test("cleanup gate rejects concurrent ingress, ensure and cleanup and releases after error", async () => {
    const gate = new WorkspaceCleanupGate();
    const cwd = asWorkspaceId("/workspace");
    let release!: () => void;
    const pending = gate.cleanup(
        cwd,
        () =>
            new Promise<void>((done) => {
                release = done;
            }),
    );
    assert.throws(() => gate.assertAvailable(cwd), /清理/);
    await assert.rejects(() => gate.run(cwd, async () => {}), /清理/);
    await assert.rejects(() => gate.cleanup(cwd, async () => {}), /清理/);
    release();
    await pending;
    await assert.rejects(
        () =>
            gate.cleanup(cwd, async () => {
                throw new Error("failed");
            }),
        /failed/,
    );
    gate.assertAvailable(cwd);
    await gate.run(cwd, async () => {
        await assert.rejects(() => gate.cleanup(cwd, async () => {}), /活动/);
    });
});

test("symlink ancestors above an auxiliary root prevent every mutation", async () => {
    const f = await fixture("ancestor");
    const transcript = await f.session("ancestor-session");
    const external = join(home, "outside-staging");
    mkdirSync(external, { recursive: true });
    const partition = hash(f.cwd, 32);
    put(join(external, "attachments", partition, "keep.txt"));
    const { renameSync } = await import("node:fs");
    const staging = join(home, "staging");
    if (existsSync(staging)) renameSync(staging, `${staging}-backup`);
    symlinkSync(external, staging);
    try {
        const result = await f.service.run(f.cwd, false);
        assert.ok(result.failed.length);
        assert.ok(existsSync(transcript));
        assert.ok(existsSync(join(external, "attachments", partition, "keep.txt")));
    } finally {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(staging);
        if (existsSync(`${staging}-backup`)) renameSync(`${staging}-backup`, staging);
    }
});

test("per-chat scratch referenced by another chat custom execution directory is retained", async () => {
    const f = await fixture("scratch-reference", true);
    const route = { channelId: "scratch-reference", peerId: "peer", chatId: "chat" };
    const scratch = put(join(f.root, "chats", chatPolicyKey(route), "scratch", "keep.txt"));
    // Historical hand-edited policies can reference a Taco-owned path, even though new grants reject it.
    put(
        join(home, "im-workspace-policies", "scratch-reference.json"),
        JSON.stringify({
            version: 2,
            chats: { other: { executionDir: { mode: "custom", path: dirname(scratch) } } },
        }),
    );
    const result = await f.service.run(f.cwd, false);
    assert.ok(existsSync(scratch));
    assert.ok(result.skipped.some((entry) => entry.path === dirname(scratch)));
});

test("descendants are removed before parent and deletion hooks run for every owned session", async () => {
    const f = await fixture("order");
    const transcripts = new Map([
        ["order-parent", await f.session("order-parent")],
        ["order-child", await f.session("order-child", "order-parent")],
        ["order-grandchild", await f.session("order-grandchild", "order-child")],
    ]);
    const deleted: string[] = [];
    const service = new WorkspaceCleanupService({
        home,
        sessionsRoot: f.root,
        runtimes: () => [],
        policy: f.policy,
        associations: f.associations,
        hasActiveWork: async () => false,
        dispose: async () => {},
        beforeSessionDeleted: async (_cwd, id) => {
            const path = transcripts.get(id);
            assert.ok(path);
            assert.ok(existsSync(path));
            assert.equal(existsSync(join(f.root, id)), false);
            deleted.push(`before:${id}`);
        },
        onSessionDeleted: async (_cwd, id) => {
            const path = transcripts.get(id);
            assert.ok(path);
            assert.equal(existsSync(path), false);
            deleted.push(id);
        },
    });
    const result = await service.run(f.cwd, false);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(deleted, [
        "before:order-grandchild",
        "order-grandchild",
        "before:order-child",
        "order-child",
        "before:order-parent",
        "order-parent",
    ]);
});

test("idle persisted pending todo items do not block cleanup", async () => {
    const f = await fixture("pending");
    const transcript = await f.session("pending-session");
    put(
        join(f.root, "pending-session", "tasks", "pending.json"),
        JSON.stringify({ tasks: [{ status: "pending" }] }),
    );
    const result = await f.service.run(f.cwd, false);
    assert.deepEqual(result.failed, []);
    assert.equal(existsSync(transcript), false);
});

test("partial session failure keeps parent route and policy for a retry", async () => {
    const f = await fixture("partial", true);
    const parent = await f.session("partial-parent");
    const child = await f.session("partial-child", "partial-parent");
    put(
        join(home, "sessions", "im", "routing.json"),
        JSON.stringify({ [f.cwd]: { sessionId: "partial-parent", lastUsedAt: 1 } }),
    );
    const router = await ConversationRouter.load(home);
    const route = { channelId: "partial", peerId: "peer", chatId: "chat" };
    await f.policy.setChatOverride(route, { tools: { shell: "allow" } });
    const service = new WorkspaceCleanupService({
        home,
        sessionsRoot: f.root,
        runtimes: () => [],
        router,
        policy: f.policy,
        associations: f.associations,
        hasActiveWork: async () => false,
        dispose: async () => {},
        beforeSessionDeleted: async () => {
            throw new Error("Work update failed");
        },
    });
    const result = await service.run(f.cwd, false);
    assert.ok(result.failed.some((entry) => entry.error.includes("Work update failed")));
    assert.ok(existsSync(parent));
    assert.equal(existsSync(child), true);
    assert.equal(router.lookupByWorkspace(f.cwd)?.sessionId, "partial-parent");
    assert.ok(f.policy.readDocument("partial").chats?.[chatPolicyKey(route)]);
});

test("route removal restores the expected entry when persistence fails", async () => {
    const f = await fixture("route-failure", true);
    const routing = join(home, "sessions", "im", "routing.json");
    put(routing, JSON.stringify({ [f.cwd]: { sessionId: "route-session", lastUsedAt: 1 } }));
    const router = await ConversationRouter.load(home);
    const { renameSync } = await import("node:fs");
    renameSync(routing, `${routing}.bak`);
    mkdirSync(routing);
    try {
        await assert.rejects(() => router.remove(f.cwd, "route-session"));
        assert.equal(router.lookupByWorkspace(f.cwd)?.sessionId, "route-session");
    } finally {
        rmSync(routing, { recursive: true });
        renameSync(`${routing}.bak`, routing);
    }
});

for (const reserved of ["im", "scratch", "chats", "--partition--"]) {
    test(`reserved auxiliary id ${reserved} never removes shared storage`, async () => {
        const f = await fixture(`reserved-${reserved.replaceAll("-", "x")}`);
        const transcript = await f.session(reserved);
        const sibling = put(join(f.root, "im", "other-channel", "keep.jsonl"));
        await assert.rejects(() => f.service.run(f.cwd, false), /标识|归属/);
        assert.ok(existsSync(transcript));
        assert.ok(existsSync(sibling));
    });
}

test("cleanup admission protects nested worktree requests in both directions", async () => {
    const gate = new WorkspaceCleanupGate();
    const main = asWorkspaceId("/project");
    const tree = asWorkspaceId("/project/.taco/worktrees/feature");
    await gate.run(tree, async () => {
        await assert.rejects(
            gate.cleanup(main, async () => undefined),
            /活动/,
        );
    });
    await gate.cleanup(tree, async () => {
        await assert.rejects(
            gate.run(main, async () => undefined),
            /清理/,
        );
        await assert.rejects(
            gate.run(asWorkspaceId(`${tree}/src`), async () => undefined),
            /清理/,
        );
        await gate.run(asWorkspaceId("/another-project"), async () => undefined);
    });
});

test("cleanup gate checks execution aliases for virtual workspaces before and during deletion", async () => {
    const tree = asWorkspaceId("/project/.taco/worktrees/feature");
    const im = asWorkspaceId("im://channel/peer/chat");
    const gate = new WorkspaceCleanupGate((key) => (key === im ? [tree] : []));
    await gate.run(im, async () => {
        await assert.rejects(
            gate.cleanup(tree, async () => undefined),
            /活动/,
        );
    });
    await gate.cleanup(tree, async () => {
        await assert.rejects(
            gate.run(im, async () => undefined),
            /清理/,
        );
    });
});
