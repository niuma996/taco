import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitWorktree, removeGitWorktree } from "../../src/git/gitService.ts";
import { WorktreeMetadataStore } from "../../src/workspace/worktreeMetadata.ts";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

async function fixture(run: (cwd: string) => Promise<void>) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "taco-worktree-metadata-")));
    try {
        git(root, "init", "--initial-branch=main");
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
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("creation persists repository identity and timestamps; removal retains a source tombstone", async () => {
    await fixture(async (cwd) => {
        const first = await createGitWorktree(cwd, "first", "head");
        const second = await createGitWorktree(cwd, "second", "head");
        const store = new WorktreeMetadataStore(cwd);
        const record = await store.get(first.path);
        assert.ok(record);
        assert.equal(record.managed, true);
        assert.equal(record.branch, first.branch);
        assert.equal(record.repositoryRoot, cwd);
        assert.equal(record.commonDir, join(cwd, ".git"));
        assert.ok(record.gitDirIdentity);
        assert.ok(Number.isFinite(Date.parse(record.createdAt)));
        assert.ok(Date.parse(record.lastSeenAt) >= Date.parse(record.createdAt));
        await removeGitWorktree(cwd, first.path);
        assert.equal((await store.get(first.path))?.state, "removed");
        assert.ok(await store.get(second.path));
    });
});

test("malformed metadata, duplicates and inconsistent identities fail closed without rewriting", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "owned", "head");
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const original = await readFile(index, "utf8");
        const valid = JSON.parse(original);
        const entry = valid.worktrees[0];
        for (const value of [
            null,
            {},
            { version: 1, worktrees: [null] },
            { ...valid, worktrees: [entry, entry] },
            ...[
                { path: join(cwd, "external") },
                { branch: "worktree/other" },
                { managed: false },
                { state: "active" },
                { commonDir: "relative" },
                { gitDir: entry.commonDir },
                { repositoryRoot: join(cwd, "other") },
                { createdAt: "yesterday" },
                { lastSeenAt: "2000-01-01T00:00:00.000Z" },
                { gitDirIdentity: null },
            ].map((patch) => ({ ...valid, worktrees: [{ ...entry, ...patch }] })),
        ]) {
            const body = JSON.stringify(value);
            await writeFile(index, body);
            await assert.rejects(new WorktreeMetadataStore(cwd).get(created.path));
            await assert.rejects(removeGitWorktree(cwd, created.path));
            await assert.rejects(createGitWorktree(cwd, "another", "head"));
            assert.equal(await readFile(index, "utf8"), body);
        }
        await writeFile(index, original);
        await removeGitWorktree(cwd, created.path);
    });
});

test("metadata index symlinks never grant ownership or overwrite their target", {
    skip: process.platform === "win32",
}, async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "owned", "head");
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const external = join(cwd, "external.json");
        const original = await readFile(index, "utf8");
        await writeFile(external, original);
        await rm(index);
        await symlink(external, index);
        await assert.rejects(new WorktreeMetadataStore(cwd).get(created.path));
        await assert.rejects(removeGitWorktree(cwd, created.path));
        await assert.rejects(createGitWorktree(cwd, "another", "head"));
        assert.equal(await readFile(external, "utf8"), original);
    });
});

test("metadata cannot mark paths outside its container", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "owned", "head");
        const store = new WorktreeMetadataStore(cwd);
        const record = await store.get(created.path);
        assert.ok(record);
        await mkdir(join(cwd, "external"));
        await assert.rejects(
            store.markManaged({ ...record, path: join(cwd, "external") }),
            /managed worktree root|metadata/,
        );
    });
});

test("deleted worktree history resolves its source while tombstones never grant live ownership", async () => {
    const { resolveGitProjectRoot, listManagedGitWorktrees } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "history", "head");
        await removeGitWorktree(cwd, created.path);
        const store = new WorktreeMetadataStore(cwd);
        const record = await store.get(created.path);
        assert.equal(record?.state, "removed");
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
        assert.equal(await resolveGitProjectRoot(join(created.path, "nested", "history")), cwd);
        const ordinary = join(cwd, "missing");
        assert.equal(await resolveGitProjectRoot(ordinary), ordinary);
        const missingProject = join(cwd, "absent-project", ".taco", "worktrees", "unknown");
        assert.equal(await resolveGitProjectRoot(missingProject), missingProject);
        const unknown = join(cwd, ".taco", "worktrees", "unknown");
        assert.equal(await resolveGitProjectRoot(unknown), unknown);
        await assert.rejects(createGitWorktree(cwd, "history", "head"));
        assert.equal((await store.get(created.path))?.state, "removed");
        git(cwd, "worktree", "add", created.path, created.branch);
        const listing = await listManagedGitWorktrees(cwd);
        assert.equal(listing.status, "repository");
        if (listing.status === "repository")
            assert.equal(
                listing.worktrees.find((tree) => tree.path === created.path)?.managed,
                false,
            );
        await assert.rejects(removeGitWorktree(cwd, created.path));
        git(cwd, "worktree", "remove", created.path);
        git(cwd, "branch", "-D", created.branch);
        const recreated = await createGitWorktree(cwd, "history", "head");
        assert.equal(recreated.path, created.path);
        assert.equal((await store.get(created.path))?.state, undefined);
        await removeGitWorktree(cwd, recreated.path);
    });
});

test("missing worktree source lookup rejects corrupted metadata, changed repository identity and symlinks", async () => {
    const { resolveGitProjectRoot } = await import("../../src/git/gitService.ts");
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "history", "head");
        await removeGitWorktree(cwd, created.path);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const original = await readFile(index, "utf8");
        const document = JSON.parse(original);
        document.worktrees[0].repositoryIdentity = "0:0:0";
        await writeFile(index, JSON.stringify(document));
        await assert.rejects(resolveGitProjectRoot(created.path));
        await writeFile(index, "{corrupt");
        await assert.rejects(resolveGitProjectRoot(created.path));
        await writeFile(index, original);
        if (process.platform !== "win32") {
            const moved = join(cwd, "saved-worktrees");
            const { rename } = await import("node:fs/promises");
            await rename(join(cwd, ".taco", "worktrees"), moved);
            await symlink(moved, join(cwd, ".taco", "worktrees"));
            await assert.rejects(resolveGitProjectRoot(created.path));
            await rm(join(cwd, ".taco", "worktrees"));
            await rename(moved, join(cwd, ".taco", "worktrees"));
        }
        await rm(join(cwd, ".git", "HEAD"));
        await assert.rejects(resolveGitProjectRoot(created.path));
    });
});

for (const mode of ["renamed", "switched", "detached"]) {
    test(`managed ${mode} worktree retains immutable ownership and reports its actual branch`, async () => {
        const { listManagedGitWorktrees, resolveGitProjectRoot } = await import(
            "../../src/git/gitService.ts"
        );
        await fixture(async (cwd) => {
            const created = await createGitWorktree(cwd, mode, "head");
            const originalOid = git(cwd, "rev-parse", created.branch).trim();
            const branch = mode === "detached" ? null : `user/${mode}`;
            if (mode === "renamed") git(created.path, "branch", "-m", branch ?? "");
            else if (mode === "switched") git(created.path, "checkout", "-b", branch ?? "");
            else git(created.path, "checkout", "--detach");
            const store = new WorktreeMetadataStore(cwd);
            assert.equal((await store.get(created.path))?.branch, created.branch);
            const listing = await listManagedGitWorktrees(cwd);
            assert.equal(listing.status, "repository");
            if (listing.status !== "repository") return;
            const tree = listing.worktrees.find((entry) => entry.path === created.path);
            assert.equal(tree?.managed, true);
            assert.equal(tree?.branch, branch);
            assert.equal(tree?.detached, mode === "detached");
            const removed = await removeGitWorktree(cwd, created.path);
            assert.equal(removed.branch, branch);
            if (branch)
                assert.equal(git(cwd, "rev-parse", `refs/heads/${branch}`).trim(), originalOid);
            if (mode !== "renamed")
                assert.equal(
                    git(cwd, "rev-parse", `refs/heads/${created.branch}`).trim(),
                    originalOid,
                );
            const record = await store.get(created.path);
            assert.equal(record?.state, "removed");
            assert.equal(record?.branch, created.branch);
            assert.equal(await resolveGitProjectRoot(created.path), cwd);
        });
    });
}

test("missing ordinary paths retain cwd and tombstone resolution never resurrects execution directories", async () => {
    const { inspectGit, resolveGitProjectRoot } = await import("../../src/git/gitService.ts");
    const { lstat } = await import("node:fs/promises");
    await fixture(async (cwd) => {
        for (const path of [
            join(cwd, "missing", "nested"),
            join(cwd, "missing-project", ".taco", "worktrees", "unknown"),
            join(cwd, ".taco", "worktrees", "unknown", "nested"),
        ]) {
            assert.equal(await resolveGitProjectRoot(path), path);
            await assert.rejects(lstat(path), { code: "ENOENT" });
        }
        await assert.rejects(lstat(join(cwd, ".taco")), { code: "ENOENT" });
        const created = await createGitWorktree(cwd, "source-only", "head");
        await removeGitWorktree(cwd, created.path);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const before = await readFile(index, "utf8");
        for (const path of [created.path, join(created.path, ".taco", "skills")]) {
            assert.equal(await resolveGitProjectRoot(path), cwd);
            await assert.rejects(lstat(path), { code: "ENOENT" });
        }
        await assert.rejects(inspectGit(created.path));
        await assert.rejects(createGitWorktree(created.path, "cannot-execute", "head"));
        assert.equal((await removeGitWorktree(cwd, created.path)).removed, true);
        assert.equal(await readFile(index, "utf8"), before);
        await assert.rejects(lstat(created.path), { code: "ENOENT" });
    });
});

for (const shape of ["bare", "separate-checkout", "separate-linked"]) {
    test(`managed inventory preserves ${shape} Git facts without mutating storage`, async () => {
        const { listGitWorktrees, listManagedGitWorktrees } = await import(
            "../../src/git/gitService.ts"
        );
        const { readdir } = await import("node:fs/promises");
        await fixture(async (cwd) => {
            const metadata = join(cwd, "separate.git");
            let requested = cwd;
            if (shape === "bare") {
                git(cwd, "clone", "--bare", ".", metadata);
                requested = metadata;
            } else {
                git(cwd, "init", "--separate-git-dir", metadata);
                if (shape === "separate-linked") {
                    requested = join(cwd, "linked");
                    git(cwd, "worktree", "add", "--detach", requested);
                }
            }
            const before = await readdir(cwd, { recursive: true });
            const inventory = await listGitWorktrees(requested);
            assert.equal(inventory.status, "repository");
            if (inventory.status !== "repository") return;
            const enriched = await listManagedGitWorktrees(requested);
            assert.deepEqual(enriched, {
                ...inventory,
                ...(shape === "separate-checkout" ? { projectRoot: cwd } : {}),
                worktrees: inventory.worktrees.map((tree) => ({ ...tree, managed: false })),
            });
            assert.deepEqual(await readdir(cwd, { recursive: true }), before);
        });
    });
}

test("managed inventory still rejects corrupted ownership metadata", async () => {
    const { listManagedGitWorktrees } = await import("../../src/git/gitService.ts");
    await fixture(async (cwd) => {
        await createGitWorktree(cwd, "owned", "head");
        await writeFile(join(cwd, ".taco", "worktrees", "index.json"), "{broken");
        await assert.rejects(listManagedGitWorktrees(cwd));
    });
});

test("removed metadata does not reserve Git admin directory names", async () => {
    await fixture(async (cwd) => {
        const external = join(cwd, "same");
        git(cwd, "worktree", "add", "--detach", external);
        const first = await createGitWorktree(cwd, "same");
        const store = new WorktreeMetadataStore(cwd);
        const old = await store.get(first.path);
        assert.equal(old?.gitDir, join(cwd, ".git", "worktrees", "same1"));
        await removeGitWorktree(cwd, first.path);
        const second = await createGitWorktree(cwd, "same1");
        assert.equal((await store.get(second.path))?.gitDir, old.gitDir);
        assert.equal((await store.get(first.path))?.state, "removed");
        await removeGitWorktree(cwd, second.path);
    });
});

test("removal retries finish persisted intent after final metadata write fails", async (t) => {
    const { listManagedGitWorktrees, resolveGitProjectRoot } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "retry");
        const remove = t.mock.method(WorktreeMetadataStore.prototype, "remove", async () => {
            throw new Error("simulated ENOSPC");
        });
        await assert.rejects(removeGitWorktree(cwd, created.path), /metadata update failed/);
        remove.mock.restore();
        const store = new WorktreeMetadataStore(cwd);
        assert.equal((await store.get(created.path))?.state, "removing");
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
        const inventory = await listManagedGitWorktrees(cwd);
        assert.equal(
            inventory.status === "repository"
                ? inventory.worktrees.some((entry) => entry.path === created.path)
                : true,
            false,
        );
        assert.equal((await store.get(created.path))?.state, "removed");
        const beforeRemove = async () =>
            assert.fail("already removed checkout must not dispose again");
        assert.equal((await removeGitWorktree(cwd, created.path, { beforeRemove })).removed, true);
        assert.equal((await store.get(created.path))?.state, "removed");
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
        assert.equal((await removeGitWorktree(cwd, created.path)).removed, true);
        await assert.rejects(removeGitWorktree(cwd, join(cwd, ".taco", "worktrees", "unknown")));
    });
});

test("inventory marks unowned managed-root checkouts as orphaned without claiming them", async () => {
    const { listManagedGitWorktrees } = await import("../../src/git/gitService.ts");
    await fixture(async (cwd) => {
        const path = join(cwd, ".taco", "worktrees", "external");
        git(cwd, "worktree", "add", "--detach", path);
        const inventory = await listManagedGitWorktrees(cwd);
        assert.equal(inventory.status, "repository");
        if (inventory.status === "repository") {
            const entry = inventory.worktrees.find((tree) => tree.path === path);
            assert.equal(entry?.managed, false);
            assert.equal(entry?.orphaned, true);
        }
    });
});

test("removal intent write failure prevents disposal and Git deletion", async (t) => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "intent");
        const begin = t.mock.method(WorktreeMetadataStore.prototype, "beginRemove", async () => {
            throw new Error("simulated ENOSPC");
        });
        await assert.rejects(
            removeGitWorktree(cwd, created.path, {
                beforeRemove: async () => assert.fail("must persist intent before disposal"),
            }),
            /simulated ENOSPC/,
        );
        begin.mock.restore();
        assert.equal((await new WorktreeMetadataStore(cwd).get(created.path))?.state, undefined);
        await removeGitWorktree(cwd, created.path);
    });
});

test("pending removal rejects replacement checkouts and retains the actual detached branch", async (t) => {
    const { resolveGitProjectRoot } = await import("../../src/git/gitService.ts");
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "pending");
        git(created.path, "checkout", "--detach");
        const remove = t.mock.method(WorktreeMetadataStore.prototype, "remove", async () => {
            throw new Error("simulated ENOSPC");
        });
        await assert.rejects(removeGitWorktree(cwd, created.path));
        remove.mock.restore();
        const record = await new WorktreeMetadataStore(cwd).get(created.path);
        assert.ok(record);
        await mkdir(record.gitDir, { recursive: true });
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
        await assert.rejects(removeGitWorktree(cwd, created.path));
        await rm(record.gitDir, { recursive: true });
        git(cwd, "worktree", "add", "--detach", created.path);
        await assert.rejects(removeGitWorktree(cwd, created.path), /identity/);
        git(cwd, "worktree", "remove", created.path);
        await mkdir(created.path);
        await assert.rejects(removeGitWorktree(cwd, created.path));
        await rm(created.path, { recursive: true });
        const result = await removeGitWorktree(cwd, created.path);
        assert.equal(result.branch, null);
        assert.equal((await removeGitWorktree(cwd, created.path)).branch, null);
    });
});

test("managed separate-git-dir provenance resolves the main checkout without core.worktree", async () => {
    const { resolveGitProjectRoot, listManagedGitWorktrees } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (cwd) => {
        git(cwd, "init", "--separate-git-dir", join(cwd, "repository-metadata"));
        assert.throws(() => git(cwd, "config", "--get", "core.worktree"));
        const created = await createGitWorktree(cwd, "provenance");
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
        const child = join(created.path, "src");
        await mkdir(child);
        assert.equal(await resolveGitProjectRoot(child), cwd);
        const listing = await listManagedGitWorktrees(created.path);
        assert.equal(listing.status, "repository");
        if (listing.status === "repository") {
            assert.equal(listing.projectRoot, cwd);
            assert.equal(
                listing.worktrees.find((tree) => tree.path === created.path)?.managed,
                true,
            );
        }
        const sibling = await createGitWorktree(child, "sibling");
        await removeGitWorktree(created.path, sibling.path);
        await removeGitWorktree(cwd, created.path);
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
    });
});

test("separate-git-dir provenance never trusts an unowned or replaced managed path", async () => {
    const { resolveGitProjectRoot } = await import("../../src/git/gitService.ts");
    await fixture(async (cwd) => {
        git(cwd, "init", "--separate-git-dir", join(cwd, "repository-metadata"));
        const created = await createGitWorktree(cwd, "provenance");
        const unowned = join(cwd, ".taco", "worktrees", "external");
        git(cwd, "worktree", "add", "--detach", unowned);
        await assert.rejects(resolveGitProjectRoot(unowned));
        git(cwd, "worktree", "remove", created.path);
        git(cwd, "worktree", "add", "--detach", created.path);
        await assert.rejects(resolveGitProjectRoot(created.path));
    });
});
