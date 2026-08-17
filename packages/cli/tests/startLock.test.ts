import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireStartLock, readStartLock, START_LOCK_TTL_MS } from "../lib/startLock.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-startlock-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("acquireStartLock writes pid + acquiredAt and is readable", async () => {
    await withTmp(async (dir) => {
        const handle = await acquireStartLock(dir);
        assert.ok(handle, "expected to acquire a fresh lock");
        const state = await readStartLock(handle.path);
        assert.ok(state);
        assert.equal(state.pid, process.pid);
        await handle.release();
        assert.equal(await readStartLock(handle.path), null);
    });
});

test("a second acquire loses while the first holder is live", async () => {
    await withTmp(async (dir) => {
        const first = await acquireStartLock(dir);
        assert.ok(first);
        const second = await acquireStartLock(dir);
        assert.equal(second, null, "second acquire must not win");
        await first.release();
        const third = await acquireStartLock(dir);
        assert.ok(third, "lock is acquirable again after release");
        await third.release();
    });
});

test("a lock older than the TTL is reclaimed", async () => {
    await withTmp(async (dir) => {
        const lockPath = join(dir, "start.lock");
        // Simulate a holder that was kill -9'd well outside the TTL.
        await writeFile(
            lockPath,
            JSON.stringify({ pid: 999999, acquiredAt: Date.now() - START_LOCK_TTL_MS - 1_000 }),
            "utf8",
        );
        const handle = await acquireStartLock(dir);
        assert.ok(handle, "stale lock must be reclaimable");
        const state = await readStartLock(handle.path);
        assert.equal(state?.pid, process.pid);
        await handle.release();
    });
});

test("release is idempotent and tolerates a missing file", async () => {
    await withTmp(async (dir) => {
        const handle = await acquireStartLock(dir);
        assert.ok(handle);
        await handle.release();
        await handle.release();
    });
});

test("a malformed lock file is treated as stale", async () => {
    await withTmp(async (dir) => {
        await writeFile(join(dir, "start.lock"), "not json", "utf8");
        const handle = await acquireStartLock(dir);
        assert.ok(handle, "unparseable lock must not wedge startup forever");
        await handle.release();
    });
});
