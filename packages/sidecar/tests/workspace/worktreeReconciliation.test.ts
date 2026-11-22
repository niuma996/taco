import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { asWorkspaceId } from "@taco-ai/protocol";
import {
    createGitWorktree,
    GitServiceError,
    inspectGit,
    listGitWorktrees,
    listManagedGitWorktrees,
    removeGitWorktree,
    resolveGitProjectRoot,
} from "../../src/git/gitService.ts";
import { createExecutionValidator } from "../../src/workspace/executionAvailability.ts";
import { createWorkspaceScope } from "../../src/workspace/workspaceScope.ts";
import { withWorktreeMutationLock } from "../../src/workspace/worktreeLock.ts";
import { WorktreeMetadataStore } from "../../src/workspace/worktreeMetadata.ts";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

function deferred() {
    let resolve: () => void = () => assert.fail("deferred was not initialized");
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function fixture(run: (cwd: string) => Promise<void>) {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "taco-worktree-reconciliation-")));
    try {
        git(cwd, "init", "--initial-branch=main");
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
        await run(cwd);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}

test("reconciliation rejects stale repository records before writing any tombstone", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "stale");
        const store = new WorktreeMetadataStore(cwd);
        await store.beginRemove(created.path, created.branch);
        git(cwd, "worktree", "remove", created.path);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const document = JSON.parse(await readFile(index, "utf8"));
        document.worktrees[0].repositoryIdentity = "0:0:0";
        const stale = JSON.stringify(document);
        await writeFile(index, stale);
        await assert.rejects(listManagedGitWorktrees(cwd), /identity/);
        assert.equal(await readFile(index, "utf8"), stale);
        assert.equal((await store.get(created.path))?.state, "removing");
    });
});

for (const shape of ["missing", "prunable", "replacement", "unowned"]) {
    test(`reconciliation reports ${shape} trees without changing metadata or deleting data`, async () => {
        await fixture(async (cwd) => {
            const created = await createGitWorktree(cwd, "orphan");
            const index = join(cwd, ".taco", "worktrees", "index.json");
            if (shape === "prunable") await rm(created.path, { recursive: true });
            else {
                git(cwd, "worktree", "remove", created.path);
                if (shape === "replacement") {
                    git(cwd, "worktree", "add", "--detach", created.path);
                    await writeFile(join(created.path, "keep"), "local data");
                } else if (shape === "unowned") {
                    await writeFile(index, JSON.stringify({ version: 1, worktrees: [] }));
                    git(cwd, "worktree", "add", "--detach", created.path);
                }
            }
            const before = await readFile(index, "utf8");
            const inventory = await listManagedGitWorktrees(cwd);
            assert.equal(inventory.status, "repository");
            if (inventory.status !== "repository") return;
            const orphan = inventory.worktrees.find((tree) => tree.path === created.path);
            assert.ok(orphan);
            assert.equal(orphan.managed, false);
            assert.equal(orphan.orphaned, true);
            assert.equal(orphan.prunable, shape === "missing" || shape === "prunable");
            assert.equal(
                orphan.stale,
                shape === "missing" || shape === "prunable" ? true : undefined,
            );
            assert.equal(await readFile(index, "utf8"), before);
            if (shape === "missing" || shape === "prunable") {
                assert.equal(await resolveGitProjectRoot(created.path), cwd);
                assert.equal(await resolveGitProjectRoot(join(created.path, "nested")), cwd);
                const validate = await createExecutionValidator(
                    createWorkspaceScope(
                        asWorkspaceId(created.path),
                        created.path,
                        created.path,
                        cwd,
                    ),
                );
                assert.ok(validate);
                await assert.rejects(validate());
                await assert.rejects(inspectGit(created.path));
                await assert.rejects(lstat(created.path), { code: "ENOENT" });
                // A verified record may forget a checkout deleted outside Taco.
                assert.equal(
                    (await removeGitWorktree(cwd, created.path, { forgetMissing: true })).removed,
                    true,
                );
                assert.equal(
                    (await new WorktreeMetadataStore(cwd).get(created.path))?.state,
                    "removed",
                );
                assert.equal(
                    (await removeGitWorktree(cwd, created.path, { forgetMissing: true })).removed,
                    true,
                );
                const after = await listManagedGitWorktrees(cwd);
                assert.equal(after.status, "repository");
                if (after.status === "repository")
                    assert.equal(
                        after.worktrees.some((tree) => tree.path === created.path),
                        false,
                    );
                return;
            }
            await assert.rejects(removeGitWorktree(cwd, created.path));
            if (shape === "replacement")
                assert.equal(await readFile(join(created.path, "keep"), "utf8"), "local data");
            if (shape === "unowned") {
                const validate = await createExecutionValidator(
                    createWorkspaceScope(
                        asWorkspaceId(created.path),
                        created.path,
                        created.path,
                        cwd,
                    ),
                );
                assert.ok(validate);
                await assert.rejects(validate());
            }
        });
    });
}

test("forgetting cannot delete a live checkout or claim a moved or replaced path", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "moved");
        const forget = () => removeGitWorktree(cwd, created.path, { forgetMissing: true });
        await assert.rejects(forget());
        git(cwd, "worktree", "move", created.path, join(cwd, "elsewhere"));
        for (const replacement of [false, true]) {
            if (replacement) await mkdir(created.path);
            const inventory = await listManagedGitWorktrees(cwd);
            assert.equal(inventory.status, "repository");
            if (inventory.status !== "repository") return;
            const entry = inventory.worktrees.find((tree) => tree.path === created.path);
            assert.ok(entry?.orphaned);
            assert.equal(entry.stale, undefined);
            await assert.rejects(forget());
        }
    });
});

test("forgetting a missing checkout never deletes a recreated directory", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "forgotten");
        await rm(created.path, { recursive: true });
        await removeGitWorktree(cwd, created.path, { forgetMissing: true });
        await mkdir(created.path, { recursive: true });
        await writeFile(join(created.path, "keep"), "local data");
        await assert.rejects(removeGitWorktree(cwd, created.path));
        assert.equal(await readFile(join(created.path, "keep"), "utf8"), "local data");
    });
});

test("reconciliation retries failed tombstone writes and then leaves removed records untouched", async (t) => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "retry");
        const store = new WorktreeMetadataStore(cwd);
        await store.beginRemove(created.path, null);
        git(cwd, "worktree", "remove", created.path);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const before = await readFile(index, "utf8");
        const original = WorktreeMetadataStore.prototype.remove;
        const failure = t.mock.method(
            WorktreeMetadataStore.prototype,
            "remove",
            async function (this: WorktreeMetadataStore, path: string) {
                const owners = await readdir(join(cwd, ".git", ".taco-worktree.lock"));
                assert.equal(owners.length, 1);
                assert.ok(owners[0]?.startsWith(`${process.pid}-`));
                if (failure.mock.callCount() === 1) throw new Error("simulated ENOSPC");
                return original.call(this, path);
            },
        );
        await assert.rejects(listManagedGitWorktrees(cwd), /simulated ENOSPC/);
        assert.equal(await readFile(index, "utf8"), before);
        const inventory = await listManagedGitWorktrees(cwd);
        assert.equal(inventory.status, "repository");
        if (inventory.status !== "repository") return;
        assert.equal(
            inventory.worktrees.some((tree) => tree.path === created.path),
            false,
        );
        assert.equal((await store.get(created.path))?.state, "removed");
        assert.equal(await resolveGitProjectRoot(created.path), cwd);
        const repaired = await readFile(index, "utf8");
        await listManagedGitWorktrees(cwd);
        assert.equal(await readFile(index, "utf8"), repaired);
        assert.equal(failure.mock.callCount(), 2);
    });
});

test("enriched inventory returns the verified main root from main and linked subdirectories", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "source");
        for (const path of [cwd, join(cwd, "subdir"), created.path, join(created.path, "subdir")]) {
            await mkdir(path, { recursive: true });
            const inventory = await listManagedGitWorktrees(path);
            assert.equal(inventory.status, "repository");
            assert.equal("projectRoot" in inventory ? inventory.projectRoot : undefined, cwd);
        }
        const external = join(cwd, "external");
        git(cwd, "worktree", "add", "--detach", external);
        assert.equal(await resolveGitProjectRoot(external), cwd);
        const inventory = await listManagedGitWorktrees(external);
        assert.equal(inventory.status, "repository");
        if (inventory.status === "repository") {
            const tree = inventory.worktrees.find((tree) => tree.path === external);
            assert.equal(tree?.managed, false);
            assert.equal(tree?.orphaned, undefined);
        }
        git(cwd, "clone", "--bare", ".", join(cwd, "bare.git"));
        assert.equal(
            "projectRoot" in (await listManagedGitWorktrees(join(cwd, "bare.git"))),
            false,
        );
    });
});

test("cleanup snapshots cannot remove a newly recreated checkout or finish its removal intent", async () => {
    await fixture(async (cwd) => {
        const first = await createGitWorktree(cwd, "recreated");
        const store = new WorktreeMetadataStore(cwd);
        const old = await store.get(first.path);
        assert.ok(old);
        await removeGitWorktree(cwd, first.path);
        git(cwd, "branch", "-D", first.branch);
        const replacement = await createGitWorktree(cwd, "recreated");
        const current = await store.get(replacement.path);
        assert.ok(current);
        assert.notEqual(current.gitDirIdentity, old.gitDirIdentity);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const options = {
            expectedGitDirIdentity: old.gitDirIdentity,
            beforeRemove: async () => assert.fail("stale selection must not dispose a replacement"),
        };
        const before = await readFile(index, "utf8");
        await assert.rejects(removeGitWorktree(cwd, replacement.path, options), /identity/);
        assert.equal(await readFile(index, "utf8"), before);
        await store.beginRemove(replacement.path, replacement.branch);
        git(cwd, "worktree", "remove", replacement.path);
        await assert.rejects(removeGitWorktree(cwd, replacement.path, options), /identity/);
        assert.equal((await store.get(replacement.path))?.state, "removing");
        const expected = { expectedGitDirIdentity: current.gitDirIdentity };
        assert.equal((await removeGitWorktree(cwd, replacement.path, expected)).removed, true);
        await assert.rejects(removeGitWorktree(cwd, replacement.path, options), /identity/);
        assert.equal((await removeGitWorktree(cwd, replacement.path, expected)).removed, true);
    });
});

test("an explicit create can reuse a missing orphan only after its branch is free", async () => {
    await fixture(async (cwd) => {
        const first = await createGitWorktree(cwd, "reuse");
        git(cwd, "worktree", "remove", first.path);
        await assert.rejects(createGitWorktree(cwd, "reuse"));
        git(cwd, "branch", "-D", first.branch);
        const next = await createGitWorktree(cwd, "reuse");
        assert.equal(next.path, first.path);
        assert.equal((await removeGitWorktree(cwd, next.path)).removed, true);
    });
});

test("cleanup rechecks detached HEAD after candidate selection", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "detach");
        const record = await new WorktreeMetadataStore(cwd).get(created.path);
        assert.ok(record);
        git(created.path, "checkout", "--detach");
        await assert.rejects(
            removeGitWorktree(cwd, created.path, { expectedGitDirIdentity: record.gitDirIdentity }),
            /detached/,
        );
        await lstat(created.path);
    });
});

test("creation rollback can list Git worktrees while holding the mutation lock", async (t) => {
    await fixture(async (cwd) => {
        t.mock.method(WorktreeMetadataStore.prototype, "markManaged", async () => {
            throw new Error("simulated ENOSPC");
        });
        await assert.rejects(createGitWorktree(cwd, "rollback"), /metadata persistence failed/);
        const inventory = await listGitWorktrees(cwd);
        assert.equal(inventory.status, "repository");
        if (inventory.status === "repository") assert.equal(inventory.worktrees.length, 1);
        assert.throws(() => git(cwd, "rev-parse", "--verify", "worktree/rollback"));
    });
});

async function waitForContender(commonDir: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!(await readdir(commonDir)).some((name) => name.startsWith(".taco-worktree.lock-"))) {
        assert.ok(Date.now() < deadline, "inventory never reached repository lock admission");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test("reconciliation takes a fresh signal after cross-process lock admission", async (t) => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "fresh");
        const store = new WorktreeMetadataStore(cwd);
        await store.beginRemove(created.path, created.branch);
        git(cwd, "worktree", "remove", created.path);
        const commonDir = join(cwd, ".git");
        const held = deferred();
        const release = deferred();
        const lock = withWorktreeMutationLock(commonDir, async () => {
            held.resolve();
            await release.promise;
        });
        await held.promise;
        const controllers: AbortController[] = [];
        t.mock.method(AbortSignal, "timeout", () => {
            const controller = new AbortController();
            controllers.push(controller);
            return controller.signal;
        });
        const pending = listManagedGitWorktrees(cwd);
        const result = Promise.allSettled([pending]);
        try {
            await waitForContender(commonDir);
            assert.ok(controllers.length >= 2);
            for (const controller of controllers) controller.abort();
        } finally {
            release.resolve();
            await lock;
        }
        await result;
        const inventory = await pending;
        assert.equal(inventory.status, "repository");
        if (inventory.status === "repository")
            assert.equal(
                inventory.worktrees.some((tree) => tree.path === created.path),
                false,
            );
    });
});

test("reconciliation rejects a common directory replaced while waiting in the mutation queue", async (t) => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "replaced-source");
        const store = new WorktreeMetadataStore(cwd);
        await store.beginRemove(created.path, created.branch);
        git(cwd, "worktree", "remove", created.path);
        const index = join(cwd, ".taco", "worktrees", "index.json");
        const commonDir = join(cwd, ".git");
        const blocker = await createGitWorktree(cwd, "blocker");
        const held = deferred();
        const release = deferred();
        const removal = removeGitWorktree(cwd, blocker.path, {
            beforeRemove: async () => {
                held.resolve();
                await release.promise;
                throw new Error("stop after replacing repository");
            },
        });
        const stopped = assert.rejects(removal, /stop after replacing/);
        await held.promise;
        const ready = deferred();
        const entries = WorktreeMetadataStore.prototype.entries;
        t.mock.method(
            WorktreeMetadataStore.prototype,
            "entries",
            async function (this: WorktreeMetadataStore) {
                const records = await entries.call(this);
                ready.resolve();
                return records;
            },
        );
        const pending = listManagedGitWorktrees(cwd);
        const rejection = assert.rejects(pending, /identity changed/);
        const observed = Promise.allSettled([rejection]);
        const queuedSnapshot = await readFile(index, "utf8");
        try {
            await ready.promise;

            await rename(commonDir, join(cwd, "old-metadata"));
            git(cwd, "init", "--initial-branch=main");
            git(
                cwd,
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@local",
                "commit",
                "--allow-empty",
                "-m",
                "replacement",
            );
        } finally {
            release.resolve();
            await stopped;
        }
        await observed;
        await rejection;
        assert.equal(await readFile(index, "utf8"), queuedSnapshot);
    });
});

test("inventory shares the in-process mutation queue with removal", async (t) => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "queued");
        const missing = await createGitWorktree(cwd, "pending-repair");
        await new WorktreeMetadataStore(cwd).beginRemove(missing.path, missing.branch);
        git(cwd, "worktree", "remove", missing.path);
        const entered = deferred();
        const release = deferred();
        const removal = removeGitWorktree(cwd, created.path, {
            beforeRemove: async () => {
                entered.resolve();
                await release.promise;
            },
        });
        await entered.promise;
        const ready = deferred();
        const entries = WorktreeMetadataStore.prototype.entries;
        t.mock.method(
            WorktreeMetadataStore.prototype,
            "entries",
            async function (this: WorktreeMetadataStore) {
                const records = await entries.call(this);
                ready.resolve();
                return records;
            },
        );
        const pending = listManagedGitWorktrees(cwd);
        const result = Promise.allSettled([pending]);
        try {
            await ready.promise;

            assert.equal(
                (await readdir(join(cwd, ".git"))).some((name) =>
                    name.startsWith(".taco-worktree.lock-"),
                ),
                false,
            );
        } finally {
            release.resolve();
            await removal;
        }
        await result;
        const inventory = await pending;
        assert.equal(inventory.status, "repository");
        if (inventory.status === "repository")
            assert.equal(
                inventory.worktrees.some((tree) => tree.path === created.path),
                false,
            );
    });
});

test("repository lock timeouts surface as Git service domain errors", async (t) => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "lock-errors");
        await new WorktreeMetadataStore(cwd).beginRemove(created.path, created.branch);
        git(cwd, "worktree", "remove", created.path);
        const held = deferred();
        const release = deferred();
        const lock = withWorktreeMutationLock(join(cwd, ".git"), async () => {
            held.resolve();
            await release.promise;
        });
        await held.promise;
        t.mock.method(
            performance,
            "now",
            (() => {
                let elapsed = 0;
                return () => (elapsed += 20_000);
            })(),
        );
        try {
            await assert.rejects(listManagedGitWorktrees(cwd), (error: unknown) => {
                assert.ok(error instanceof GitServiceError);
                assert.equal(error.reason, "command_failed");
                assert.match(error.message, /Timed out/);
                return true;
            });
        } finally {
            release.resolve();
            await lock;
        }
    });
});

test("ordinary inventory remains readable while another process holds the mutation lock", async () => {
    await fixture(async (cwd) => {
        const created = await createGitWorktree(cwd, "read-only");
        await withWorktreeMutationLock(join(cwd, ".git"), async () => {
            const inventory = await listManagedGitWorktrees(cwd);
            assert.equal(inventory.status, "repository");
            if (inventory.status === "repository") {
                assert.equal(inventory.projectRoot, cwd);
                assert.equal(
                    inventory.worktrees.find((tree) => tree.path === created.path)?.managed,
                    true,
                );
            }
        });
    });
});
