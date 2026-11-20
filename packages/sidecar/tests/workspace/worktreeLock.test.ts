import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
        const firstHeld = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const first = withWorktreeMutationLock(
            commonDir,
            async () => {
                events.push("first-start");
                await firstHeld;
                events.push("first-end");
            },
            { retryMs: 1, timeoutMs: 500 },
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        const second = withWorktreeMutationLock(
            commonDir,
            async () => {
                events.push("second");
            },
            { retryMs: 1, timeoutMs: 500 },
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(events, ["first-start"]);
        releaseFirst();
        await Promise.all([first, second]);
        assert.deepEqual(events, ["first-start", "first-end", "second"]);
    });
});

test("reclaims an expired owner and removes the lock after release", async () => {
    await fixture(async (commonDir) => {
        const lock = join(commonDir, ".taco-worktree.lock");
        await mkdir(lock);
        await writeFile(
            join(lock, "owner.json"),
            JSON.stringify({
                pid: 999999,
                token: "expired",
                expiresAt: new Date(Date.now() - 1).toISOString(),
            }),
        );
        await withWorktreeMutationLock(
            commonDir,
            async () => {
                const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as {
                    token: string;
                };
                assert.notEqual(owner.token, "expired");
            },
            { retryMs: 1, timeoutMs: 500, leaseMs: 50 },
        );
        await assert.rejects(readFile(join(lock, "owner.json"), "utf8"), { code: "ENOENT" });
    });
});
