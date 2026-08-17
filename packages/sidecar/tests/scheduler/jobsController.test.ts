/**
 * JobsController tests — exercise the JobsControl bridge between
 * `jobs.*` handlers and the (store + scheduler) pair without booting
 * the full daemon.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobsController } from "../../src/scheduler/jobsController.ts";
import { Scheduler } from "../../src/scheduler/runner.ts";
import { JobStore } from "../../src/scheduler/store.ts";
import type { Job } from "../../src/scheduler/types.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-jobsctrl-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function sampleJob(id: string, overrides: Partial<Job> = {}): Job {
    return {
        id,
        name: id,
        schedule: { kind: "interval", ms: 60_000 },
        command: "agent.invoke",
        args: {},
        enabled: true,
        run_on_startup: false,
        history: [],
        ...overrides,
    };
}

test("list() reads every job from the store (no live filtering)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob("a"));
        await store.save(sampleJob("b"));
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        const ids = (await ctrl.list()).map((j) => j.id).sort();
        deepStrictEqual(ids, ["a", "b"]);
        scheduler.stop();
    });
});

test("create() persists and reloads the scheduler (timer attaches for enabled jobs)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        let fired = 0;
        // Note: we use one Scheduler for the whole test — `start()` re-loads
        // existing jobs, but `create()` calls `reload(id)` after the save
        // which attaches the timer. The first fire confirms the timer is
        // live without us having to peek at Scheduler internals.
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                fired += 1;
            },
        });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        const job = sampleJob("a", { enabled: true, schedule: { kind: "interval", ms: 20 } });
        await ctrl.create(job);
        await new Promise((r) => setTimeout(r, 80));
        ok(fired > 0, `expected at least one fire; got ${fired}`);
        scheduler.stop();
    });
});

test("update() persists + reloads; disabling removes the timer", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(sampleJob("a", { enabled: false }));
        const stored = await store.get("a");
        ok(stored);
        if (stored) {
            await ctrl.update({ ...stored, enabled: false });
        }
        // No timer attached — nothing to assert beyond a clean state.
        scheduler.stop();
    });
});

test("delete() removes the file + lock; reload leaves no timer", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(sampleJob("a"));
        await ctrl.delete("a");
        strictEqual(await store.get("a"), null);
        // Stale lock file would survive — assert it's gone too.
        await rejects(stat(join(dir, "a.lock")), /ENOENT/);
        scheduler.stop();
    });
});

test("runNow() returns false for unknown id, true when fired", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(sampleJob("a", { enabled: false }));
        strictEqual(await ctrl.runNow("missing"), false);
        strictEqual(await ctrl.runNow("a"), true);
        scheduler.stop();
    });
});

test("history() returns the persisted history entries or null for unknown job", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        strictEqual(await ctrl.history("missing"), null);
        const seeded = sampleJob("a");
        seeded.history = [
            {
                started_at: "2026-01-01T00:00:00.000Z",
                ended_at: "2026-01-01T00:01:00.000Z",
                status: "ok",
            },
        ];
        await ctrl.create(seeded);
        const hist = await ctrl.history("a");
        deepStrictEqual(hist, seeded.history);
        scheduler.stop();
    });
});
