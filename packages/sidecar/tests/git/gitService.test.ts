import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
async function fixture(run: (root: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "taco-git-d1-"));
    try {
        await run(await realpath(root));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
async function repository(root: string) {
    const cwd = join(root, "main repo");
    await mkdir(cwd);
    git(cwd, "init", "--initial-branch=main");
    git(
        cwd,
        "-c",
        "user.name=Taco test",
        "-c",
        "user.email=test@local",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
    );
    return cwd;
}

test("identifies unborn repositories and initializes only the selected directory", async () => {
    const { inspectGit, initializeGit } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        assert.deepEqual(await inspectGit(root), { status: "not_repository" });
        const created = await initializeGit(root);
        assert.equal(created.status, "repository");
        if (created.status !== "repository") return;
        assert.equal(created.repository.checkoutRoot, root);
        assert.equal(created.repository.headOid, null);
        assert.ok(created.repository.branch);
        const child = join(root, "nested");
        await mkdir(child);
        const nested = await initializeGit(child);
        assert.equal(nested.status, "repository");
        const { existsSync } = await import("node:fs");
        assert.equal(
            existsSync(join(child, ".git")),
            false,
            "never create a nested repository inside an existing checkout",
        );
    });
});

test("linked worktrees share Git metadata while detached HEAD and unusual filenames retain identity", async () => {
    const { inspectGit, listGitWorktrees } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const linked = join(root, "linked tree");
        git(cwd, "worktree", "add", "--detach", linked, "HEAD");
        const [main, worktree] = await Promise.all([inspectGit(cwd), inspectGit(linked)]);
        assert.equal(main.status, "repository");
        assert.equal(worktree.status, "repository");
        if (main.status !== "repository" || worktree.status !== "repository") return;
        assert.equal(main.repository.branch, "main");
        assert.equal(worktree.repository.branch, null);
        assert.equal(main.repository.commonDir, worktree.repository.commonDir);
        assert.notEqual(main.repository.gitDir, worktree.repository.gitDir);
        const listing = await listGitWorktrees(linked);
        assert.equal(listing.status, "repository");
        if (listing.status !== "repository") return;
        assert.equal(listing.worktrees.length, 2);
        assert.ok(listing.worktrees.some((tree) => tree.path === linked && tree.detached));
        await writeFile(join(linked, "new 中文 file\nname.txt"), "new");
        const status = await inspectGit(linked);
        assert.equal(status.status, "repository");
        if (status.status === "repository")
            assert.equal(status.changes[0].path, "new 中文 file\nname.txt");
    });
});

test("creates and removes managed worktrees under the project Taco directory", async () => {
    const { createGitWorktree, removeGitWorktree } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const created = await createGitWorktree(cwd, "feature-one", "head");
        assert.equal(created.path, join(cwd, ".taco", "worktrees", "feature-one"));
        assert.equal(created.branch, "worktree/feature-one");
        assert.equal(created.managed, true);
        const listing = git(cwd, "worktree", "list", "--porcelain");
        assert.match(listing, /feature-one/);
        const removed = await removeGitWorktree(cwd, created.path);
        assert.equal(removed.path, created.path);
        assert.equal(removed.branch, created.branch);
        assert.doesNotMatch(git(cwd, "worktree", "list", "--porcelain"), /feature-one/);
    });
});

test("rejects unsafe worktree names and paths outside the managed root", async () => {
    const { createGitWorktree, removeGitWorktree, GitServiceError } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (root) => {
        const cwd = await repository(root);
        await assert.rejects(createGitWorktree(cwd, "../escape", "head"), (error: unknown) => {
            return error instanceof GitServiceError && error.reason === "invalid_path";
        });
        await assert.rejects(removeGitWorktree(cwd, join(root, "outside")), (error: unknown) => {
            return error instanceof GitServiceError && error.reason === "invalid_path";
        });
    });
});

test("reports staged, unstaged, deleted, renamed and untracked paths relative to the selected subtree", async () => {
    const { inspectGit } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const sub = join(cwd, "src");
        await mkdir(sub);
        for (const name of ["edit.txt", "delete.txt", "rename.txt"])
            await writeFile(join(sub, name), name);
        await writeFile(join(cwd, "outside.txt"), "outside");
        git(cwd, "add", ".");
        git(
            cwd,
            "-c",
            "user.name=Taco test",
            "-c",
            "user.email=test@local",
            "commit",
            "-m",
            "files",
        );
        await writeFile(join(sub, "edit.txt"), "changed");
        await rm(join(sub, "delete.txt"));
        git(cwd, "mv", "src/rename.txt", "src/renamed.txt");
        await writeFile(join(sub, "new.txt"), "new");
        await writeFile(join(cwd, "outside.txt"), "changed outside");
        const result = await inspectGit(sub);
        assert.equal(result.status, "repository");
        if (result.status !== "repository") return;
        const changes = new Map(result.changes.map((entry) => [entry.path, entry]));
        assert.equal(changes.get("edit.txt")?.kind, "modified");
        assert.equal(changes.get("delete.txt")?.kind, "deleted");
        assert.equal(changes.get("renamed.txt")?.originalPath, "rename.txt");
        assert.equal(changes.get("new.txt")?.kind, "added");
        assert.equal(changes.has("../outside.txt"), false);
    });
});

test("handles bare and separate Git directories without deriving a checkout from commonDir", async () => {
    const { inspectGit, listGitWorktrees } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const bare = join(root, "bare.git");
        await mkdir(bare);
        git(bare, "init", "--bare");
        const result = await inspectGit(bare);
        assert.equal(result.status, "repository");
        if (result.status === "repository") {
            assert.equal(result.repository.isBare, true);
            assert.equal(result.repository.checkoutRoot, null);
            assert.deepEqual(result.changes, []);
        }
        const cwd = join(root, "checkout");
        await mkdir(cwd);
        git(cwd, "init", "--separate-git-dir", join(root, "metadata"));
        const separate = await listGitWorktrees(cwd);
        assert.equal(separate.status, "repository");
        if (separate.status === "repository") {
            assert.equal(separate.repository.checkoutRoot, cwd);
            assert.equal(separate.repository.commonDir, join(root, "metadata"));
        }
    });
});

test("reports missing Git separately from repository or directory errors", async () => {
    const { inspectGit, GitServiceError } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const before = process.env.PATH;
        try {
            process.env.PATH = "";
            assert.deepEqual(await inspectGit(root), { status: "missing" });
        } finally {
            if (before === undefined) Reflect.deleteProperty(process.env, "PATH");
            else process.env.PATH = before;
        }
        await assert.rejects(
            inspectGit(join(root, "missing")),
            (error: unknown) => error instanceof GitServiceError && error.reason === "invalid_path",
        );
    });
});

test("ambient Git overrides cannot redirect inspection or initialization", async () => {
    const { inspectGit, initializeGit } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const other = join(root, "other");
        await mkdir(other);
        const beforeDir = process.env.GIT_DIR,
            beforeWork = process.env.GIT_WORK_TREE;
        try {
            process.env.GIT_DIR = join(cwd, ".git");
            process.env.GIT_WORK_TREE = cwd;
            const empty = await inspectGit(other);
            assert.deepEqual(empty, { status: "not_repository" });
            const created = await initializeGit(other);
            assert.equal(created.status, "repository");
            if (created.status === "repository")
                assert.equal(created.repository.checkoutRoot, other);
        } finally {
            if (beforeDir === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
            else process.env.GIT_DIR = beforeDir;
            if (beforeWork === undefined) Reflect.deleteProperty(process.env, "GIT_WORK_TREE");
            else process.env.GIT_WORK_TREE = beforeWork;
        }
    });
});

test("reports merge conflicts and locked or missing worktrees", async () => {
    const { inspectGit, listGitWorktrees } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const commit = (message: string) =>
            git(
                cwd,
                "-c",
                "user.name=Taco test",
                "-c",
                "user.email=test@local",
                "commit",
                "-am",
                message,
            );
        await writeFile(join(cwd, "conflict.txt"), "base\n");
        git(cwd, "add", ".");
        commit("base");
        git(cwd, "checkout", "-b", "other");
        await writeFile(join(cwd, "conflict.txt"), "other\n");
        commit("other");
        git(cwd, "checkout", "main");
        await writeFile(join(cwd, "conflict.txt"), "main\n");
        commit("main");
        assert.throws(() =>
            git(cwd, "-c", "user.name=Taco test", "-c", "user.email=test@local", "merge", "other"),
        );
        const result = await inspectGit(cwd);
        assert.equal(result.status, "repository");
        if (result.status === "repository")
            assert.equal(
                result.changes.find((entry) => entry.path === "conflict.txt")?.kind,
                "conflict",
            );
        const locked = join(root, "locked");
        git(cwd, "worktree", "add", "--detach", locked, "HEAD");
        git(cwd, "worktree", "lock", "--reason", "keep on disk", locked);
        const missing = join(root, "missing-worktree");
        git(cwd, "worktree", "add", "--detach", missing, "HEAD");
        await rm(missing, { recursive: true });
        const list = await listGitWorktrees(cwd);
        assert.equal(list.status, "repository");
        if (list.status === "repository") {
            assert.equal(
                list.worktrees.find((tree) => tree.path === locked)?.lockReason,
                "keep on disk",
            );
            assert.equal(list.worktrees.find((tree) => tree.path === missing)?.prunable, true);
        }
    });
});

test("a submodule is an independent repository rather than its parent checkout", async () => {
    const { inspectGit } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const source = join(root, "source");
        await mkdir(source);
        git(source, "init");
        git(
            source,
            "-c",
            "user.name=Taco test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "source",
        );
        git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
        const submodule = await inspectGit(join(cwd, "module"));
        assert.equal(submodule.status, "repository");
        if (submodule.status === "repository") {
            assert.equal(submodule.repository.checkoutRoot, join(cwd, "module"));
            assert.notEqual(submodule.repository.commonDir, join(cwd, ".git"));
        }
    });
});

test("preserves literal backslashes in POSIX filenames and recognizes a symlinked workspace", {
    skip: process.platform === "win32",
}, async () => {
    const { inspectGit } = await import("../../src/git/gitService.ts");
    const { symlink } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const alias = join(root, "alias");
        await symlink(cwd, alias);
        await writeFile(join(cwd, "literal\\name.txt"), "content");
        const result = await inspectGit(alias);
        assert.equal(result.status, "repository");
        if (result.status === "repository") {
            assert.equal(result.repository.checkoutRoot, cwd);
            assert.equal(result.changes[0].path, "literal\\name.txt");
        }
    });
});

test("automatic inspection never invokes repository fsmonitor hooks", {
    skip: process.platform === "win32",
}, async () => {
    const { inspectGit } = await import("../../src/git/gitService.ts");
    const { chmod, access } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const script = join(root, "monitor"),
            marker = join(root, "invoked");
        await writeFile(
            script,
            `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`,
        );
        await chmod(script, 0o755);
        git(cwd, "config", "core.fsmonitor", script);
        await inspectGit(cwd);
        await assert.rejects(access(marker), { code: "ENOENT" });
    });
});

test("corrupt repository metadata is never offered for reinitialization", async () => {
    const { inspectGit, initializeGit, GitServiceError } = await import(
        "../../src/git/gitService.ts"
    );
    const { access } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        await rm(join(cwd, ".git", "HEAD"));
        const isFailure = (error: unknown) =>
            error instanceof GitServiceError && error.reason === "command_failed";
        await assert.rejects(inspectGit(cwd), isFailure);
        await assert.rejects(initializeGit(cwd), isFailure);
        await assert.rejects(access(join(cwd, ".git", "HEAD")), { code: "ENOENT" });
    });
});

test("preserves carriage returns at the end of POSIX repository directory names", {
    skip: process.platform === "win32",
}, async () => {
    const { inspectGit } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = join(root, "repo\r");
        await mkdir(cwd);
        git(cwd, "init");
        const result = await inspectGit(cwd);
        assert.equal(result.status, "repository");
        if (result.status === "repository") assert.equal(result.repository.checkoutRoot, cwd);
    });
});

test("one shared request signal cancels the remaining Git probe stages", {
    skip: process.platform === "win32",
}, async () => {
    const { inspectGit, GitServiceError } = await import("../../src/git/gitService.ts");
    const { chmod, readFile } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const actualGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
        const bin = join(root, "bin");
        await mkdir(bin);
        const trace = join(root, "trace");
        await writeFile(
            join(bin, "git"),
            `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)}, 'call\\n'); setTimeout(() => { const child = require('node:child_process').spawnSync(${JSON.stringify(actualGit)}, process.argv.slice(2), {stdio: 'inherit'}); process.exit(child.status ?? 1); }, 100);\n`,
        );
        await chmod(join(bin, "git"), 0o755);
        const previous = process.env.PATH;
        const deadline = AbortSignal.timeout(500);
        try {
            process.env.PATH = `${bin}:${previous ?? ""}`;
            await assert.rejects(
                inspectGit(cwd, { signal: deadline }),
                (error: unknown) => error instanceof GitServiceError,
            );
            assert.equal(deadline.aborted, true);
            // Under suite load the deadline can cancel before the child starts.
            const calls = await readFile(trace, "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return "";
                throw error;
            });
            const count = calls.trim() ? calls.trim().split("\n").length : 0;
            assert.ok(count < 7, `probe stopped before all stages: ${count}`);
        } finally {
            if (previous === undefined) Reflect.deleteProperty(process.env, "PATH");
            else process.env.PATH = previous;
        }
    });
});

// These tests use real Git inventories and on-disk metadata rather than mocked commands.
test("project identity preserves ordinary subdirectories and maps only verified linked trees", async () => {
    const { resolveGitProjectRoot } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const sub = join(cwd, "src");
        await mkdir(sub);
        assert.equal(await resolveGitProjectRoot(sub), sub);
        assert.equal(await resolveGitProjectRoot(root), root);
        const linked = join(root, "linked");
        git(cwd, "worktree", "add", "--detach", linked);
        await mkdir(join(linked, "nested"));
        assert.equal(await resolveGitProjectRoot(join(linked, "nested")), cwd);
        const previous = process.env.PATH;
        try {
            process.env.PATH = "";
            assert.equal(await resolveGitProjectRoot(sub), sub);
        } finally {
            if (previous === undefined) Reflect.deleteProperty(process.env, "PATH");
            else process.env.PATH = previous;
        }
    });
});

test("separate git directories resolve linked checkouts through inventory", async () => {
    const { resolveGitProjectRoot, createGitWorktree, removeGitWorktree } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (root) => {
        const cwd = await repository(root);
        const metadata = join(root, "repository-metadata");
        git(cwd, "init", `--separate-git-dir=${metadata}`);
        const sub = join(cwd, "src");
        await mkdir(sub);
        assert.equal(await resolveGitProjectRoot(sub), sub);
        const linked = join(root, "linked");
        git(cwd, "worktree", "add", "--detach", linked);
        // Git inventory alone reports the separate git directory, not the checkout.
        await assert.rejects(resolveGitProjectRoot(linked));
        await assert.rejects(createGitWorktree(linked, "unverified", "head"));
        git(cwd, "config", "core.worktree", cwd);
        assert.equal(await resolveGitProjectRoot(linked), cwd);
        const created = await createGitWorktree(linked, "separate", "head");
        assert.equal(created.path, join(cwd, ".taco", "worktrees", "separate"));
        await removeGitWorktree(sub, created.path);
    });
});

test("creation snapshots the source HEAD and uses only the local origin default ref", async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const mainHead = git(cwd, "rev-parse", "HEAD").trim();
        const linked = join(root, "linked");
        git(cwd, "worktree", "add", "--detach", linked);
        git(
            linked,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "source",
        );
        const sourceHead = git(linked, "rev-parse", "HEAD").trim();
        const created = await createGitWorktree(linked, "source-head", "head");
        assert.equal(created.headOid, sourceHead);
        await assert.rejects(createGitWorktree(cwd, "no-default", "default"), /default/);
        git(cwd, "update-ref", "refs/remotes/origin/main", mainHead);
        git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        git(cwd, "config", "remote.origin.url", join(root, "missing-remote"));
        assert.equal(
            (await createGitWorktree(linked, "default-base", "default")).headOid,
            mainHead,
        );
        assert.equal(git(cwd, "rev-parse", "HEAD").trim(), mainHead);
    });
});

test("creation records ownership, serializes same-repository requests, and retains deleted branches", async () => {
    const { createGitWorktree, removeGitWorktree, listManagedGitWorktrees } = await import(
        "../../src/git/gitService.ts"
    );
    const { WorktreeMetadataStore } = await import("../../src/workspace/worktreeMetadata.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const sibling = join(root, "sibling");
        git(cwd, "worktree", "add", "--detach", sibling);
        const trees = await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
                createGitWorktree(i % 2 ? cwd : sibling, `parallel-${i}`, "head"),
            ),
        );
        const store = new WorktreeMetadataStore(cwd);
        for (const tree of trees) {
            const record = await store.get(tree.path);
            assert.ok(record);
            assert.equal(record.commonDir, join(cwd, ".git"));
            assert.equal(record.repositoryRoot, cwd);
            assert.ok(record.gitDir.startsWith(join(cwd, ".git", "worktrees")));
            assert.ok(Date.parse(record.createdAt) <= Date.parse(record.lastSeenAt));
        }
        const listed = await listManagedGitWorktrees(sibling);
        assert.equal(listed.status, "repository");
        if (listed.status === "repository") {
            assert.equal(listed.worktrees.filter((entry) => entry.managed).length, 4);
            assert.equal(listed.worktrees.find((entry) => entry.path === sibling)?.managed, false);
        }
        const competing = await Promise.allSettled([
            createGitWorktree(cwd, "same", "head"),
            createGitWorktree(sibling, "same", "head"),
        ]);
        assert.equal(competing.filter((entry) => entry.status === "fulfilled").length, 1);
        assert.ok(await store.get(join(cwd, ".taco", "worktrees", "same")));
        await Promise.all(trees.map((tree) => removeGitWorktree(sibling, tree.path)));
        for (const tree of trees) {
            assert.equal((await store.get(tree.path))?.state, "removed");
            assert.ok(git(cwd, "rev-parse", "--verify", `refs/heads/${tree.branch}`));
        }
    });
});

test("unsafe names and symlink ancestors never create external artifacts", async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    const { symlink, readdir } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        for (const name of [
            "CON",
            "con",
            "prn",
            "aux",
            "nul",
            "com1",
            "lpt9",
            "Upper",
            "a/b",
            "a\\b",
            "-flag",
            "a.lock",
            "",
            "a".repeat(81),
        ])
            await assert.rejects(createGitWorktree(cwd, name, "head"), /name/);
        if (process.platform === "win32") return;
        const outside = join(root, "outside");
        await mkdir(outside);
        await symlink(outside, join(cwd, ".taco"));
        await assert.rejects(createGitWorktree(cwd, "escape", "head"));
        assert.deepEqual(await readdir(outside), []);
        await rm(join(cwd, ".taco"));
        await mkdir(join(cwd, ".taco"));
        await symlink(outside, join(cwd, ".taco", "worktrees"));
        await assert.rejects(createGitWorktree(cwd, "escape", "head"));
        assert.deepEqual(await readdir(outside), []);
    });
});

test("managed container is locally excluded and tracked containers are never copied", async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    const { access } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        await createGitWorktree(cwd, "clean", "head");
        assert.equal(git(cwd, "status", "--porcelain"), "");
        assert.ok(git(cwd, "check-ignore", ".taco/worktrees/index.json"));
        await access(join(cwd, ".taco", "worktrees", "clean", ".git"));
    });
    await fixture(async (root) => {
        const cwd = await repository(root);
        await mkdir(join(cwd, ".taco", "worktrees"), { recursive: true });
        await writeFile(join(cwd, ".taco", "worktrees", "user-data"), "keep");
        git(cwd, "add", ".");
        git(
            cwd,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "-m",
            "container",
        );
        await assert.rejects(createGitWorktree(cwd, "recursive", "head"), /tracked|container/);
        await assert.rejects(access(join(cwd, ".taco", "worktrees", "recursive")), {
            code: "ENOENT",
        });
    });
});

test("removal requires metadata ownership and rejects ignored data, runtime data, locks and main checkout", async () => {
    const { createGitWorktree, removeGitWorktree } = await import("../../src/git/gitService.ts");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const external = join(cwd, ".taco", "worktrees", "external");
        git(cwd, "worktree", "add", "-b", "worktree/external", external);
        await assert.rejects(removeGitWorktree(cwd, external));
        await assert.rejects(removeGitWorktree(cwd, cwd));
        const created = await createGitWorktree(cwd, "owned", "head");
        git(cwd, "worktree", "lock", created.path);
        await assert.rejects(removeGitWorktree(cwd, created.path), /locked/);
        git(cwd, "worktree", "unlock", created.path);
        await writeFile(join(created.path, ".gitignore"), "secret\n.taco/\n");
        git(created.path, "add", ".gitignore");
        git(
            created.path,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "-m",
            "ignore",
        );
        await writeFile(join(created.path, "secret"), "preserve");
        await assert.rejects(removeGitWorktree(cwd, created.path), /changes|dirty|files/);
        await rm(join(created.path, "secret"));
        await mkdir(join(created.path, ".taco"));
        await writeFile(join(created.path, ".taco", "runtime.json"), "{}");
        await assert.rejects(removeGitWorktree(cwd, created.path));
        await rm(join(created.path, ".taco"), { recursive: true });
        await removeGitWorktree(cwd, created.path);
    });
});

test("a replaced worktree identity cannot inherit stale metadata ownership", async () => {
    const { createGitWorktree, removeGitWorktree, listManagedGitWorktrees } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (root) => {
        const cwd = await repository(root);
        const created = await createGitWorktree(cwd, "replaced", "head");
        git(cwd, "worktree", "remove", created.path);
        git(cwd, "worktree", "add", "--detach", created.path);
        await assert.rejects(removeGitWorktree(cwd, created.path));
        const listed = await listManagedGitWorktrees(cwd);
        if (listed.status === "repository")
            assert.equal(
                listed.worktrees.find((entry) => entry.path === created.path)?.managed,
                false,
            );
    });
});

test("failed creation preserves preexisting branches, directories and malformed metadata", async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    const { readFile } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        git(cwd, "branch", "worktree/existing");
        await assert.rejects(createGitWorktree(cwd, "existing", "head"));
        assert.ok(git(cwd, "rev-parse", "--verify", "worktree/existing"));
        const path = join(cwd, ".taco", "worktrees", "directory");
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "keep"), "preserve");
        await assert.rejects(createGitWorktree(cwd, "directory", "head"));
        assert.equal(await readFile(join(path, "keep"), "utf8"), "preserve");
        const index = join(cwd, ".taco", "worktrees", "index.json");
        await writeFile(index, "{broken");
        await assert.rejects(createGitWorktree(cwd, "bad-metadata", "head"));
        assert.equal(await readFile(index, "utf8"), "{broken");
        assert.throws(() => git(cwd, "rev-parse", "--verify", "worktree/bad-metadata"));
    });
});

test("damaged linked metadata and missing main checkouts never fall back to another identity", async () => {
    const { resolveGitProjectRoot, createGitWorktree } = await import(
        "../../src/git/gitService.ts"
    );
    await fixture(async (root) => {
        const cwd = await repository(root);
        const linked = join(root, "linked");
        git(cwd, "worktree", "add", "--detach", linked);
        await rm(join(cwd, ".git", "HEAD"));
        await assert.rejects(resolveGitProjectRoot(linked));
        await assert.rejects(resolveGitProjectRoot(cwd));
        await assert.rejects(createGitWorktree(linked, "blocked", "head"));
    });
    await fixture(async (root) => {
        const cwd = await repository(root);
        const linked = join(root, "linked");
        git(cwd, "worktree", "add", "--detach", linked);
        await writeFile(join(linked, ".git"), "gitdir: missing-metadata\n");
        await assert.rejects(resolveGitProjectRoot(linked));
    });
});

test("ordinary symlink callers and submodule directories retain workspace identity", {
    skip: process.platform === "win32",
}, async () => {
    const { resolveGitProjectRoot, createGitWorktree, removeGitWorktree } = await import(
        "../../src/git/gitService.ts"
    );
    const { symlink } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const alias = join(root, "alias");
        await symlink(cwd, alias);
        assert.equal(await resolveGitProjectRoot(alias), alias);
        const source = join(root, "source");
        await mkdir(source);
        git(source, "init");
        git(
            source,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
        const module = join(cwd, "module");
        await mkdir(join(module, "sub"));
        assert.equal(await resolveGitProjectRoot(join(module, "sub")), join(module, "sub"));
        const created = await createGitWorktree(module, "module-tree", "head");
        assert.equal(created.path, join(module, ".taco", "worktrees", "module-tree"));
        assert.equal(await resolveGitProjectRoot(created.path), module);
        await assert.rejects(removeGitWorktree(cwd, created.path));
        await removeGitWorktree(module, created.path);
    });
});

test("beforeRemove runs inside the queue only after successful validation and can abort deletion", async () => {
    const { createGitWorktree, removeGitWorktree } = await import("../../src/git/gitService.ts");
    const { access } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const created = await createGitWorktree(cwd, "callback", "head");
        let called = 0;
        const beforeRemove = async () => {
            called++;
        };
        await writeFile(join(created.path, "dirty"), "keep");
        await assert.rejects(removeGitWorktree(cwd, created.path, { beforeRemove }));
        assert.equal(called, 0);
        await rm(join(created.path, "dirty"));
        git(cwd, "worktree", "lock", created.path);
        await assert.rejects(removeGitWorktree(cwd, created.path, { beforeRemove }));
        assert.equal(called, 0);
        git(cwd, "worktree", "unlock", created.path);
        await assert.rejects(
            removeGitWorktree(cwd, created.path, {
                beforeRemove: async () => {
                    throw new Error("runtime busy");
                },
            }),
            /runtime busy/,
        );
        await access(created.path);
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const removal = removeGitWorktree(cwd, created.path, {
            beforeRemove: async () => {
                called++;
                await access(created.path);
                entered?.();
                await gate;
            },
        });
        await ready;
        const competing = removeGitWorktree(cwd, created.path, { beforeRemove });
        release?.();
        await removal;
        await assert.rejects(competing);
        assert.equal(called, 1);
    });
});

test("metadata persistence failure rolls back only a clean worktree and branch created by this call", {
    skip: process.platform === "win32",
}, async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    const { chmod, access, readFile } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        // A checkout hook simulates another writer corrupting metadata after preflight.
        const hook = join(cwd, ".git", "hooks", "post-checkout");
        await writeFile(
            hook,
            `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(index)}, '{corrupt');\n`,
        );
        await chmod(hook, 0o755);
        await assert.rejects(createGitWorktree(cwd, "rollback", "head"));
        assert.equal(await readFile(index, "utf8"), "{corrupt");
        await assert.rejects(access(join(cwd, ".taco", "worktrees", "rollback")), {
            code: "ENOENT",
        });
        assert.doesNotMatch(git(cwd, "worktree", "list", "--porcelain"), /worktree\/rollback/);
        assert.throws(() => git(cwd, "rev-parse", "--verify", "refs/heads/worktree/rollback"));
    });
});

test("failed creation preserves local files produced during checkout", {
    skip: process.platform === "win32",
}, async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    const { chmod, readFile } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        const path = join(cwd, ".taco", "worktrees", "preserve");
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const hook = join(cwd, ".git", "hooks", "post-checkout");
        await writeFile(
            hook,
            `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(index)}, '{broken'); fs.writeFileSync(${JSON.stringify(join(path, "local-data"))}, 'keep');\n`,
        );
        await chmod(hook, 0o755);
        await assert.rejects(createGitWorktree(cwd, "preserve", "head"));
        assert.equal(await readFile(join(path, "local-data"), "utf8"), "keep");
        assert.ok(git(cwd, "rev-parse", "--verify", "refs/heads/worktree/preserve"));
        assert.match(git(cwd, "worktree", "list", "--porcelain"), /worktree\/preserve/);
    });
});

test("creation respects an existing ignore rule and preserves unrelated Taco tracked files", async () => {
    const { createGitWorktree } = await import("../../src/git/gitService.ts");
    const { readFile } = await import("node:fs/promises");
    await fixture(async (root) => {
        const cwd = await repository(root);
        await mkdir(join(cwd, ".taco"));
        await writeFile(join(cwd, ".taco", "settings.json"), "{}");
        await writeFile(join(cwd, ".gitignore"), "/.taco/worktrees/\n");
        git(cwd, "add", ".");
        git(cwd, "-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "settings");
        const exclude = join(cwd, ".git", "info", "exclude");
        const before = await readFile(exclude, "utf8");
        const created = await createGitWorktree(cwd, "settings", "head");
        assert.equal(await readFile(exclude, "utf8"), before);
        assert.equal(await readFile(join(created.path, ".taco", "settings.json"), "utf8"), "{}");
        assert.equal(git(cwd, "status", "--porcelain"), "");
    });
});

for (const flag of ["assume-unchanged", "skip-worktree"]) {
    test(`removal preserves edits hidden by ${flag} and never calls beforeRemove`, async () => {
        const { createGitWorktree, removeGitWorktree } = await import(
            "../../src/git/gitService.ts"
        );
        const { readFile } = await import("node:fs/promises");
        await fixture(async (root) => {
            const cwd = await repository(root);
            const file = "tracked file\nwith newline.txt";
            await writeFile(join(cwd, file), "committed\n");
            git(cwd, "add", "--", file);
            git(
                cwd,
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@local",
                "commit",
                "-m",
                "tracked",
            );
            const created = await createGitWorktree(cwd, flag, "head");
            git(created.path, "update-index", `--${flag}`, "--", file);
            await writeFile(join(created.path, file), "local edits to preserve\n");
            assert.equal(git(created.path, "status", "--porcelain"), "");
            const tag = flag === "skip-worktree" ? "S" : "h";
            assert.equal(git(created.path, "ls-files", "-v", "-z"), `${tag} ${file}\0`);
            let callbackCalled = false;
            await assert.rejects(
                removeGitWorktree(cwd, created.path, {
                    beforeRemove: async () => {
                        callbackCalled = true;
                    },
                }),
                /assume-unchanged|skip-worktree|index flags/,
            );
            assert.equal(callbackCalled, false);
            assert.equal(
                await readFile(join(created.path, file), "utf8"),
                "local edits to preserve\n",
            );
            git(created.path, "update-index", `--no-${flag}`, "--", file);
            await assert.rejects(removeGitWorktree(cwd, created.path), /changes/);
            git(created.path, "restore", "--", file);
            await removeGitWorktree(cwd, created.path);
            assert.ok(git(cwd, "rev-parse", "--verify", `refs/heads/${created.branch}`));
        });
    });
}
