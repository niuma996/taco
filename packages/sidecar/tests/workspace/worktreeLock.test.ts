import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { withWorktreeMutationLock } from "../../src/workspace/worktreeLock.ts";

async function fixture(run: (commonDir: string) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "taco-worktree-lock-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("serializes same-repository mutations across lock contenders", async () => {
    await fixture(async (commonDir) => {
        const events: string[] = [];
        let releaseFirst!: () => void;
        let markFirstStarted!: () => void;
        const firstHeld = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const firstStarted = new Promise<void>((resolve) => {
            markFirstStarted = resolve;
        });
        const first = withWorktreeMutationLock(
            commonDir,
            async () => {
                events.push("first-start");
                markFirstStarted();
                await firstHeld;
                events.push("first-end");
            },
            { retryMs: 1, timeoutMs: 5000 },
        );
        await firstStarted;
        const second = withWorktreeMutationLock(
            commonDir,
            async () => {
                events.push("second");
            },
            { retryMs: 1, timeoutMs: 5000 },
        );
        try {
            const candidatePrefix = `.taco-worktree.lock-${process.pid}-`;
            const deadline = Date.now() + 4000;
            while (!(await readdir(commonDir)).some((name) => name.startsWith(candidatePrefix))) {
                assert.ok(Date.now() < deadline, "second lock contender did not start");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.deepEqual(events, ["first-start"]);
        } finally {
            releaseFirst();
            await Promise.all([first, second]);
        }
        assert.deepEqual(events, ["first-start", "first-end", "second"]);
    });
});

test("reclaims a dead process owner and releases the lock", async () => {
    await fixture(async (commonDir) => {
        const lock = join(commonDir, ".taco-worktree.lock");
        await mkdir(lock);
        await writeFile(join(lock, "999999-00000000-0000-0000-0000-000000000000"), "");
        await withWorktreeMutationLock(
            commonDir,
            async () => {
                await access(lock);
            },
            { retryMs: 1, timeoutMs: 500 },
        );
        await assert.rejects(access(lock), { code: "ENOENT" });
    });
});

test("does not steal a lock from a live process", async () => {
    await fixture(async (commonDir) => {
        const lock = join(commonDir, ".taco-worktree.lock");
        await mkdir(lock);
        await writeFile(join(lock, `${process.pid}-00000000-0000-0000-0000-000000000000`), "");
        await assert.rejects(
            withWorktreeMutationLock(
                commonDir,
                async () => {
                    assert.fail("live owner's critical section was entered");
                },
                { timeoutMs: 30, retryMs: 1 },
            ),
            /Timed out/,
        );
    });
});

test("separate processes share one critical section", async () => {
    await fixture(async (commonDir) => {
        const trace = join(commonDir, "trace");
        const moduleUrl = new URL("../../src/workspace/worktreeLock.ts", import.meta.url).href;
        const script = `
            import { appendFile } from 'node:fs/promises';
            import { withWorktreeMutationLock } from ${JSON.stringify(moduleUrl)};
            await withWorktreeMutationLock(process.argv[1], async () => {
                await appendFile(process.argv[2], process.pid + ':start\\n');
                await new Promise(resolve => setTimeout(resolve, 50));
                await appendFile(process.argv[2], process.pid + ':end\\n');
            });
        `;
        const run = () =>
            promisify(execFile)(process.execPath, [
                "--experimental-transform-types",
                "--input-type=module",
                "-e",
                script,
                commonDir,
                trace,
            ]);
        await Promise.all([run(), run(), run()]);
        const { readFile } = await import("node:fs/promises");
        const events = (await readFile(trace, "utf8")).trim().split("\n");
        assert.equal(events.length, 6);
        for (let i = 0; i < events.length; i += 2) {
            assert.ok(events[i].endsWith(":start"));
            assert.equal(events[i + 1], events[i].replace(":start", ":end"));
        }
    });
});

test("does not reclaim a dead owner while its Git subprocess outcome is unknown", async () => {
    await fixture(async (commonDir) => {
        const lock = join(commonDir, ".taco-worktree.lock");
        await mkdir(lock);
        await writeFile(join(lock, "999999-00000000-0000-0000-0000-000000000000"), "");
        await writeFile(join(lock, "git-active-interrupted"), "");
        await assert.rejects(
            withWorktreeMutationLock(
                commonDir,
                async () => {
                    assert.fail("interrupted Git lock was reclaimed");
                },
                { timeoutMs: 30, retryMs: 1 },
            ),
            /Timed out/,
        );
        await access(join(lock, "git-active-interrupted"));
    });
});

test("parallel Git probes each release their own durable marker", async () => {
    const { withWorktreeGitCommand } = await import("../../src/workspace/worktreeLock.ts");
    await fixture(async (commonDir) => {
        await withWorktreeMutationLock(commonDir, () =>
            Promise.all([
                withWorktreeGitCommand(async () => "first"),
                withWorktreeGitCommand(async () => "second"),
            ]),
        );
        await assert.rejects(access(join(commonDir, ".taco-worktree.lock")), { code: "ENOENT" });
    });
});

test("uncertain Git abort retains the lock without changing the operation error", async () => {
    const { withWorktreeGitCommand } = await import("../../src/workspace/worktreeLock.ts");
    await fixture(async (commonDir) => {
        const failure = Object.assign(new Error("cancelled"), { code: "ABORT_ERR" });
        await assert.rejects(
            withWorktreeMutationLock(commonDir, () =>
                withWorktreeGitCommand(async () => {
                    throw failure;
                }),
            ),
            (error) => error === failure,
        );
        await assert.rejects(
            withWorktreeMutationLock(
                commonDir,
                async () => {
                    assert.fail("aborted command lock was reclaimed");
                },
                { timeoutMs: 25, retryMs: 1 },
            ),
            /Timed out/,
        );
    });
});

// Git hooks can outlive the sidecar that launched the checkout.
test("killing a real worktree creator during checkout leaves its repository locked", {
    skip: process.platform === "win32",
}, async () => {
    await fixture(async (cwd) => {
        const git = (...args: string[]) =>
            execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
        git("init", "--initial-branch=main");
        git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@local",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        );
        const common = join(cwd, ".git");
        const hook = join(common, "hooks", "post-checkout");
        await writeFile(
            hook,
            `#!/bin/sh
base=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
touch "$base/entered"
for i in $(seq 1 300); do
    if test -e "$base/resume"; then break; fi
    sleep 0.1
done
touch "$base/finished"
`,
            { mode: 0o700 },
        );
        const waitFor = async (name: string) => {
            const deadline = Date.now() + 10000;
            while (!(await readdir(common)).includes(name)) {
                assert.ok(Date.now() < deadline, `hook did not reach ${name}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        };
        const service = new URL("../../src/git/gitService.ts", import.meta.url).href;
        const child = spawn(
            process.execPath,
            [
                "--experimental-transform-types",
                "--input-type=module",
                "-e",
                `import {createGitWorktree} from ${JSON.stringify(service)}; await createGitWorktree(process.argv[1], "interrupt");`,
                cwd,
            ],
            { stdio: "ignore" },
        );
        const exited = once(child, "exit");
        try {
            await waitFor("entered");
            child.kill("SIGKILL");
            await exited;
            assert.ok(
                (await readdir(join(common, ".taco-worktree.lock"))).some((name) =>
                    name.startsWith("git-active-"),
                ),
            );
            await assert.rejects(
                withWorktreeMutationLock(common, async () => assert.fail("checkout still active"), {
                    timeoutMs: 30,
                    retryMs: 1,
                }),
                /Timed out/,
            );
        } finally {
            await writeFile(join(common, "resume"), "");
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await exited;
        }
        await waitFor("finished");
    });
});
