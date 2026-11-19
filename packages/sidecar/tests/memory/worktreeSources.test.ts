import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { LocalMemoryStore, workspaceKey } from "../../src/memory/local/store.ts";
import { readScopedMemoryTopic } from "../../src/memory/scopedRead.ts";
import { buildLayeredMemoryBlock, resolveMemorySources } from "../../src/memory/sources.ts";
import { ProviderKeyStore } from "../../src/runtime/models/providerKeyStore.ts";
import { WorkspaceRuntime } from "../../src/runtime/workspace.ts";
import { registerMemoryHandlers } from "../../src/server/handlers/memory.ts";
import { getRegisteredMethod, type MethodCtx } from "../../src/server/methodRegistry.ts";
import { resolveMemoryRoot } from "../../src/workspace/memoryRoot.ts";
import { createWorkspaceScope } from "../../src/workspace/workspaceScope.ts";
import { useTempTacoHome } from "../_helpers/tempTacoHome.ts";

const home = useTempTacoHome("worktree-memory");
const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();

function repository(name: string, separate = false) {
    const root = join(realpathSync(home), name);
    mkdirSync(root, { recursive: true });
    const metadata = join(realpathSync(home), `${name}-metadata`);
    git(root, "init", "-b", "main", ...(separate ? [`--separate-git-dir=${metadata}`] : []));
    if (separate) git(root, "config", "core.worktree", root);
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
    const linked = (path: string) => {
        git(root, "worktree", "add", "--detach", path);
        return path;
    };
    return { root, linked };
}

async function memory(root: string) {
    const store = new LocalMemoryStore();
    store.initialize(root);
    await store.appendEntry({
        id: "shared",
        name: "Shared",
        description: "Project note",
        type: "project",
        content: "Shared full body",
        createdAt: "2026-11-20T00:00:00.000Z",
    });
    return store;
}

function options(store: LocalMemoryStore, associatedRoots: string[]) {
    return { store, target: "channel" as const, associatedRoots, inheritManagedGlobal: false };
}

describe("associated worktree memory", () => {
    it("preserves ordinary partitions and stops at nested repository boundaries", () => {
        const repo = repository("ordinary");
        const child = join(repo.root, "src");
        mkdirSync(child);
        assert.equal(resolveMemoryRoot(repo.root), repo.root);
        assert.equal(resolveMemoryRoot(child), child);
        const tree = repo.linked(join(realpathSync(home), "boundary-external"));
        const nested = join(tree, "nested");
        mkdirSync(nested);
        git(nested, "init");
        assert.equal(resolveMemoryRoot(nested), nested);
        assert.equal(resolveMemoryRoot(join(tree, "missing")), join(tree, "missing"));
    });

    it("rejects a main checkout whose config redirects execution elsewhere", () => {
        const repo = repository("redirected");
        const tree = repo.linked(join(realpathSync(home), "redirected-external"));
        const other = join(realpathSync(home), "other-checkout");
        mkdirSync(other);
        git(repo.root, "config", "core.worktree", other);
        assert.equal(resolveMemoryRoot(tree), tree);
    });

    it("falls back without throwing for unsupported ownership config syntax", () => {
        const repo = repository("config-subset");
        const tree = repo.linked(join(realpathSync(home), "config-subset-external"));
        const config = join(repo.root, ".git", "config");
        const original = readFileSync(config, "utf8");
        for (const extra of [
            "[core] # ownership\nworktree = elsewhere\n",
            "[include]\npath = extra-config\n",
            "[extensions]\nworktreeConfig = true\n",
            "[core]\nworktree = elsewhere\\\ncontinued\n",
        ]) {
            writeFileSync(config, original + extra);
            assert.equal(resolveMemoryRoot(tree), tree, extra);
        }
        writeFileSync(config, original);
        assert.equal(resolveMemoryRoot(tree), repo.root);
    });

    it("reads cold managed and external worktrees with one owner source id and rechecks grants", async () => {
        const repo = repository("cold");
        const nested = repo.linked(join(repo.root, ".taco", "worktrees", "topic"));
        const external = repo.linked(join(realpathSync(home), "external"));
        const child = join(external, "src");
        mkdirSync(child);
        const alias = join(realpathSync(home), "external-alias");
        symlinkSync(external, alias, "dir");
        const project = await memory(repo.root);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/chat");
        const args = {
            ...options(current, [nested, external, child, alias, repo.root]),
            inheritManagedGlobal: true,
            managedGlobalRoots: [external, repo.root],
        };
        const sources = resolveMemorySources(args);
        assert.equal(sources.associatedWorkspaces.length, 1);
        assert.equal(sources.associatedWorkspaces[0]?.key, repo.root);
        assert.equal(sources.associatedWorkspaces[0]?.entries[0]?.content, "Shared full body");
        assert.deepEqual(sources.managedGlobal, []);
        const reference = {
            memoryLayer: "workspace" as const,
            sourceId: project.dirKey,
            id: "shared",
        };
        assert.ok(buildLayeredMemoryBlock(sources).includes(JSON.stringify(reference)));
        assert.equal(readScopedMemoryTopic(args, reference).content, "Shared full body");
        args.associatedRoots = [external];
        assert.equal(readScopedMemoryTopic(args, reference).content, "Shared full body");
        args.associatedRoots = [];
        args.inheritManagedGlobal = false;
        assert.throws(() => readScopedMemoryTopic(args, reference), /not available/);
        args.associatedRoots = [nested];
        assert.throws(
            () => readScopedMemoryTopic(args, { ...reference, sourceId: workspaceKey(external) }),
            /not available/,
        );
    });

    it("uses the same owner in memory.list and memory.read without a live project runtime", async () => {
        const repo = repository("rpc");
        const tree = repo.linked(join(realpathSync(home), "rpc-external"));
        const project = await memory(repo.root);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/rpc");
        let roots = [tree];
        registerMemoryHandlers();
        const rpc = async (method: string, params: unknown) => {
            const registered = getRegisteredMethod(method);
            assert.ok(registered);
            return registered.handler({
                workspace: {
                    memoryStore: current,
                    imRouting: { channelId: "mock", peerId: "peer", chatId: "rpc" },
                    associatedRoots: () => roots,
                    inheritsManagedGlobalMemory: () => false,
                    managedGlobalMemoryRoots: () => [],
                },
                server: {},
                params,
            } as unknown as MethodCtx<unknown>);
        };
        const list = (await rpc("memory.list", {})) as {
            topics: { id: string; sourceId: string; memoryLayer: string; readOnly: boolean }[];
        };
        assert.equal(list.topics.length, 1);
        assert.equal(list.topics[0]?.sourceId, project.dirKey);
        assert.equal(list.topics[0]?.readOnly, true);
        const reference = { id: "shared", sourceId: project.dirKey, memoryLayer: "workspace" };
        const read = (await rpc("memory.read", reference)) as { topic: { content: string } };
        assert.equal(read.topic.content, "Shared full body");
        roots = [];
        await assert.rejects(rpc("memory.read", reference), /not available/);
    });

    it("injects cold worktree memory into a real IM runtime and removes it after revocation", async () => {
        const repo = repository("runtime");
        const tree = repo.linked(join(realpathSync(home), "runtime-external"));
        const project = await memory(repo.root);
        const execution = join(home, "im-execution");
        mkdirSync(execution);
        let roots = [tree];
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId("im://mock/peer/runtime"), execution),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
            resolveAssociatedRoots: () => roots,
        });
        try {
            const block = runtime.memoryContextStore.buildMemoryBlock();
            assert.match(block, /Shared/);
            assert.ok(block.includes(project.dirKey));
            roots = [];
            assert.doesNotMatch(runtime.memoryContextStore.buildMemoryBlock(), /Shared/);
        } finally {
            await runtime.dispose();
        }
    });

    it("accepts relative Git pointers and a verified separate Git directory", async () => {
        const repo = repository("separate space", true);
        const tree = repo.linked(join(realpathSync(home), "separate-external"));
        const gitDir = git(tree, "rev-parse", "--absolute-git-dir");
        writeFileSync(join(tree, ".git"), `gitdir: ${relative(tree, gitDir)}\n`);
        writeFileSync(join(gitDir, "gitdir"), `${relative(gitDir, join(tree, ".git"))}\n`);
        await memory(repo.root);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/separate");
        assert.equal(
            resolveMemorySources(options(current, [tree])).associatedWorkspaces[0]?.key,
            repo.root,
        );
        assert.equal(
            resolveMemorySources(options(current, [tree])).associatedWorkspaces[0]?.entries[0]?.id,
            "shared",
        );
    });

    it("does not widen ownership for forged backlinks, invalid common dirs or missing main checkouts", async () => {
        const repo = repository("invalid");
        const tree = repo.linked(join(realpathSync(home), "invalid-external"));
        const gitDir = git(tree, "rev-parse", "--absolute-git-dir");
        await memory(repo.root);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/invalid");
        const args = options(current, [tree]);
        const originalBacklink = readFileSync(join(gitDir, "gitdir"));
        writeFileSync(join(gitDir, "gitdir"), `${join(repo.root, ".git")}\n`);
        assert.deepEqual(resolveMemorySources(args).associatedWorkspaces[0]?.entries, []);
        writeFileSync(join(gitDir, "gitdir"), originalBacklink);
        const originalCommon = readFileSync(join(gitDir, "commondir"));
        writeFileSync(join(gitDir, "commondir"), `${join(repo.root, "..", "unrelated")}\n`);
        assert.deepEqual(resolveMemorySources(args).associatedWorkspaces[0]?.entries, []);
        writeFileSync(join(gitDir, "commondir"), originalCommon);
        assert.equal(resolveMemorySources(args).associatedWorkspaces[0]?.entries[0]?.id, "shared");
        rmSync(join(repo.root, ".git"), { recursive: true });
        assert.deepEqual(resolveMemorySources(args).associatedWorkspaces[0]?.entries, []);
    });

    it("allows an injected owner resolver while retaining live grant enforcement", async () => {
        const owner = join(home, "injected-project");
        const grant = join(home, "injected-tree");
        const project = await memory(owner);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/injected");
        const args = {
            ...options(current, [grant, owner]),
            resolveMemoryRoot: (root: string) => (root === grant ? owner : root),
        };
        const sources = resolveMemorySources(args);
        assert.equal(sources.associatedWorkspaces.length, 1);
        assert.equal(sources.associatedWorkspaces[0]?.entries[0]?.id, "shared");
        args.associatedRoots = [];
        assert.throws(
            () =>
                readScopedMemoryTopic(args, {
                    memoryLayer: "workspace",
                    sourceId: project.dirKey,
                    id: "shared",
                }),
            /not available/,
        );
    });
});
