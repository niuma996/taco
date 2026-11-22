import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import { LocalMemoryStore, workspaceKey } from "../../src/memory/local/store.ts";
import { readScopedMemoryTopic } from "../../src/memory/scopedRead.ts";
import {
    buildLayeredMemoryBlock,
    prepareMemorySources,
    resolveMemorySources,
} from "../../src/memory/sources.ts";
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
    it("preserves ordinary partitions and stops at nested repository boundaries", async () => {
        const repo = repository("ordinary");
        const child = join(repo.root, "src");
        mkdirSync(child);
        assert.equal(await resolveMemoryRoot(repo.root), repo.root);
        assert.equal(await resolveMemoryRoot(child), child);
        const tree = repo.linked(join(realpathSync(home), "boundary-external"));
        const nested = join(tree, "nested");
        mkdirSync(nested);
        const alias = join(home, "aliased-child");
        symlinkSync(nested, alias, "dir");
        assert.equal(await resolveMemoryRoot(alias), repo.root);
        git(nested, "init");
        assert.equal(await resolveMemoryRoot(nested), nested);
        assert.equal(await resolveMemoryRoot(join(tree, "missing")), join(tree, "missing"));
    });

    it("preserves non-repository and missing roots during preparation", async () => {
        const plain = join(home, "plain-directory");
        const missing = join(home, "missing-directory");
        mkdirSync(plain);
        await memory(plain);
        await memory(missing);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/ordinary");
        const sources = resolveMemorySources(
            await prepareMemorySources(options(current, [plain, missing])),
        );
        assert.deepEqual(
            sources.associatedWorkspaces.map((layer) => layer.key),
            [plain, missing],
        );
        assert.deepEqual(
            sources.associatedWorkspaces.map((layer) => layer.entries[0]?.id),
            ["shared", "shared"],
        );
    });

    it("rejects a main checkout whose config redirects execution elsewhere", async () => {
        const repo = repository("redirected");
        const tree = repo.linked(join(realpathSync(home), "redirected-external"));
        const other = join(realpathSync(home), "other-checkout");
        mkdirSync(other);
        git(repo.root, "config", "core.worktree", other);
        assert.equal(await resolveMemoryRoot(tree), tree);
    });

    it("falls back without throwing for invalid ownership config", async () => {
        const repo = repository("config-subset");
        const tree = repo.linked(join(realpathSync(home), "config-subset-external"));
        const config = join(repo.root, ".git", "config");
        const original = readFileSync(config, "utf8");
        for (const extra of [
            "[core] # ownership\nworktree = elsewhere\n",
            "[core]\nworktree = elsewhere\\\ncontinued\n",
        ]) {
            writeFileSync(config, original + extra);
            assert.equal(await resolveMemoryRoot(tree), tree, extra);
        }
        writeFileSync(config, original);
        assert.equal(await resolveMemoryRoot(tree), repo.root);
    });

    it("uses Git ownership with includes and per-worktree config on every context read", async () => {
        const repo = repository("included-owner");
        const tree = repo.linked(join(realpathSync(home), "included-tree"));
        await memory(repo.root);
        const execution = join(home, "included-im");
        mkdirSync(execution);
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId("im://mock/peer/includes"), execution),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
            resolveAssociatedRoots: () => [tree],
        });
        try {
            for (const extra of [
                "[include]\npath = extra-config\n",
                "[extensions]\nworktreeConfig = true\n",
            ]) {
                const config = join(repo.root, ".git", "config");
                writeFileSync(config, readFileSync(config, "utf8") + extra);
                writeFileSync(join(repo.root, ".git", "extra-config"), "[user]\nname = Test\n");
                assert.match(await runtime.memoryContextStore.buildMemoryBlock(), /Shared/);
            }
        } finally {
            await runtime.dispose();
        }
    });

    it("migrates old worktree topics before cold IM context reads", async () => {
        const repo = repository("cold-migration");
        const tree = repo.linked(join(realpathSync(home), "cold-migration-tree"));
        await memory(tree);
        const execution = join(home, "cold-migration-im");
        mkdirSync(execution);
        let roots = [tree];
        const runtime = new WorkspaceRuntime({
            scope: createWorkspaceScope(asWorkspaceId("im://mock/peer/migration"), execution),
            providerKeyStore: new ProviderKeyStore({}),
            tools: [],
            resolveAssociatedRoots: () => roots,
        });
        try {
            assert.match(await runtime.memoryContextStore.buildMemoryBlock(), /Shared/);
            assert.equal(
                LocalMemoryStore.openByKey(workspaceKey(repo.root)).getTopic("shared")?.content,
                "Shared full body",
            );
            roots = [];
            assert.doesNotMatch(await runtime.memoryContextStore.buildMemoryBlock(), /Shared/);
        } finally {
            await runtime.dispose();
        }
    });

    it("reimports when the destination partition is restored without its completion marker", async () => {
        const repo = repository("restore-import");
        const tree = repo.linked(join(realpathSync(home), "restore-import-tree"));
        await memory(tree);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/restore-import");
        const args = options(current, [tree]);
        await prepareMemorySources(args);
        const owner = LocalMemoryStore.openByKey(workspaceKey(repo.root));
        rmSync(owner.topicDir, { recursive: true });
        await prepareMemorySources(args);
        assert.equal(owner.getTopic("shared")?.content, "Shared full body");
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
        const sources = resolveMemorySources(await prepareMemorySources(args));
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
        assert.equal(
            readScopedMemoryTopic(await prepareMemorySources(args), reference).content,
            "Shared full body",
        );
        args.associatedRoots = [external];
        assert.equal(
            readScopedMemoryTopic(await prepareMemorySources(args), reference).content,
            "Shared full body",
        );
        args.associatedRoots = [];
        args.inheritManagedGlobal = false;
        await assert.rejects(
            async () => readScopedMemoryTopic(await prepareMemorySources(args), reference),
            /not available/,
        );
        args.associatedRoots = [nested];
        await assert.rejects(
            async () =>
                readScopedMemoryTopic(await prepareMemorySources(args), {
                    ...reference,
                    sourceId: workspaceKey(external),
                }),
            /not available/,
        );
    });

    it("uses the same owner in memory.list and memory.read without a live project runtime", async () => {
        const repo = repository("rpc");
        const tree = repo.linked(join(realpathSync(home), "rpc-external"));
        await memory(tree);
        git(repo.root, "config", "include.path", "extra-config");
        writeFileSync(join(repo.root, ".git", "extra-config"), "[user]\nname = Test\n");
        const project = LocalMemoryStore.openByKey(workspaceKey(repo.root));
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
            const block = await runtime.memoryContextStore.buildMemoryBlock();
            assert.match(block, /Shared/);
            assert.ok(block.includes(project.dirKey));
            roots = [];
            assert.doesNotMatch(await runtime.memoryContextStore.buildMemoryBlock(), /Shared/);
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
            resolveMemorySources(await prepareMemorySources(options(current, [tree])))
                .associatedWorkspaces[0]?.key,
            repo.root,
        );
        assert.equal(
            resolveMemorySources(await prepareMemorySources(options(current, [tree])))
                .associatedWorkspaces[0]?.entries[0]?.id,
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
        assert.deepEqual(
            resolveMemorySources(await prepareMemorySources(args)).associatedWorkspaces[0]?.entries,
            [],
        );
        writeFileSync(join(gitDir, "gitdir"), originalBacklink);
        const originalCommon = readFileSync(join(gitDir, "commondir"));
        writeFileSync(join(gitDir, "commondir"), `${join(repo.root, "..", "unrelated")}\n`);
        assert.deepEqual(
            resolveMemorySources(await prepareMemorySources(args)).associatedWorkspaces[0]?.entries,
            [],
        );
        writeFileSync(join(gitDir, "commondir"), originalCommon);
        assert.equal(
            resolveMemorySources(await prepareMemorySources(args)).associatedWorkspaces[0]
                ?.entries[0]?.id,
            "shared",
        );
        rmSync(join(repo.root, ".git"), { recursive: true });
        assert.deepEqual(
            resolveMemorySources(await prepareMemorySources(args)).associatedWorkspaces[0]?.entries,
            [],
        );
    });

    it("rechecks grants after asynchronous preparation and before a scoped read", async () => {
        const repo = repository("revoked-during-prepare");
        const tree = repo.linked(join(realpathSync(home), "revoked-during-prepare-tree"));
        const project = await memory(repo.root);
        const current = new LocalMemoryStore();
        current.initialize("im://mock/peer/revoked");
        let roots = [tree];
        const prepared = prepareMemorySources(() => options(current, roots));
        roots = [];
        const snapshot = await prepared;
        assert.deepEqual(resolveMemorySources(snapshot).associatedWorkspaces, []);
        assert.throws(
            () =>
                readScopedMemoryTopic(snapshot, {
                    memoryLayer: "workspace",
                    sourceId: project.dirKey,
                    id: "shared",
                }),
            /not available/,
        );
        roots = [tree];
        const allowed = await prepareMemorySources(() => options(current, roots));
        roots = [];
        assert.deepEqual(resolveMemorySources(allowed).associatedWorkspaces, []);
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
        const sources = resolveMemorySources(await prepareMemorySources(args));
        assert.equal(sources.associatedWorkspaces.length, 1);
        assert.equal(sources.associatedWorkspaces[0]?.entries[0]?.id, "shared");
        args.associatedRoots = [];
        await assert.rejects(
            async () =>
                readScopedMemoryTopic(await prepareMemorySources(args), {
                    memoryLayer: "workspace",
                    sourceId: project.dirKey,
                    id: "shared",
                }),
            /not available/,
        );
    });
});
