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
