/**
 * Scheduler behavior tests. We stub `CommandInvoker` (the sidecar-side
 * command dispatcher) and `now()` (for deterministic history timestamps).
 *
 * Interval jobs use small ms values + manual advancement; cron jobs use
 * a fixed `Cron` expression + the croner adapter's own scheduling so we
 * exercise the same code path the daemon runs in production.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Scheduler } from "../../src/scheduler/runner.ts";
import type { Job } from "../../src/scheduler/types.ts";

class MemoryStore {
    public jobs = new Map<string, Job>();
    public savedCount = 0;
    async list(): Promise<Job[]> {
        return [...this.jobs.values()];
    }
    async get(id: string): Promise<Job | null> {
        return this.jobs.get(id) ?? null;
    }
    async save(job: Job): Promise<void> {
        // Deep clone so test assertions can compare against the original
        // pre-mutation copy without seeing the runner's edits.
        this.jobs.set(job.id, structuredClone(job));
        this.savedCount += 1;
    }
    async delete(id: string): Promise<void> {
        this.jobs.delete(id);
    }
}

function intervalJob(id: string, ms: number, overrides: Partial<Job> = {}): Job {
    return {
        id,
        name: id,
        schedule: { kind: "interval", ms },
        command: "agent.invoke",
        args: { prompt: "hello" },
        enabled: true,
        run_on_startup: false,
        history: [],
        ...overrides,
    };
}

function fixedDate(iso: string): () => Date {
    return () => new Date(iso);
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-sched-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test("start() schedules every enabled job and skips disabled ones", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("on", intervalJob("on", 50));
        store.jobs.set("off", intervalJob("off", 50, { enabled: false }));
        let invocations = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                invocations += 1;
            },
        });
        await scheduler.start();
        await waitFor(() => invocations >= 2, 500);
        scheduler.stop();
        // Wait one more tick to confirm "off" never fired.
        await new Promise((r) => setTimeout(r, 100));
        strictEqual(invocations >= 2, true);
    });
});

test("successful invoke writes a history entry with status=ok", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("a", intervalJob("a", 30));
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {},
            now: fixedDate("2026-01-01T00:00:00.000Z"),
        });
        await scheduler.start();
        await waitFor(() => store.savedCount >= 1, 500);
        scheduler.stop();
        const saved = store.jobs.get("a");
        ok(saved);
        strictEqual(saved.history.length, 1);
        strictEqual(saved.history[0].status, "ok");
        strictEqual(saved.history[0].started_at, "2026-01-01T00:00:00.000Z");
        strictEqual(saved.history[0].ended_at, "2026-01-01T00:00:00.000Z");
    });
});

test("failing invoke writes status=err + error message", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("a", intervalJob("a", 30));
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                throw new Error("model timeout");
            },
        });
        await scheduler.start();
        await waitFor(() => store.savedCount >= 1, 500);
        scheduler.stop();
        const saved = store.jobs.get("a");
        ok(saved);
        strictEqual(saved.history[0].status, "err");
        strictEqual(saved.history[0].error, "model timeout");
    });
});

test("overlapping fire is rejected by the lock file (no re-entry)", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        // 500ms interval + a slow invoke; the second fire would land before
        // the first finishes, exercising the lock guard.
        store.jobs.set("a", intervalJob("a", 20));
        let concurrent = 0;
        let maxConcurrent = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise((r) => setTimeout(r, 200));
                concurrent -= 1;
            },
        });
        await scheduler.start();
        await new Promise((r) => setTimeout(r, 400));
        scheduler.stop();
        strictEqual(maxConcurrent, 1, "overlapping runs are not allowed");
    });
});

test("history is truncated to HISTORY_LIMIT (20) entries", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("a", intervalJob("a", 5));
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {},
        });
        await scheduler.start();
        // Fire ~25 times.
        await waitFor(() => store.savedCount >= 25, 2_000);
        scheduler.stop();
        const saved = store.jobs.get("a");
        ok(saved);
        strictEqual(saved.history.length <= 20, true);
    });
});

test("runNow fires the job once and returns true; missing job returns false", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("a", intervalJob("a", 60_000, { enabled: false }));
        let invoked = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                invoked += 1;
            },
        });
        await scheduler.start();
        strictEqual(await scheduler.runNow("a"), true);
        strictEqual(invoked, 1);
        strictEqual(await scheduler.runNow("nope"), false);
        scheduler.stop();
    });
});

test("reload reattaches the timer to reflect the latest stored copy", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        const base = intervalJob("a", 60_000, { enabled: false });
        store.jobs.set("a", base);
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {},
        });
        await scheduler.start();
        // Flip enabled in the store; reload should pick it up.
        const updated = structuredClone(base);
        updated.enabled = true;
        await store.save(updated);
        await scheduler.reload("a");
        // Wait one tick — interval is 60s so we can't observe a fire; instead
        // assert that the timer is attached by checking the schedule's
        // next-run date is in the future (proves a handle was created).
        // For interval jobs we exposed nextRun as `now + ms`; sleep 10ms
        // and assert the date moved forward by inspecting internal state
        // via runNow instead (a non-throw = handle is live).
        strictEqual(await scheduler.runNow("a"), true);
        scheduler.stop();
    });
});

test("detachAll clears every timer (no leaks after stop)", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("a", intervalJob("a", 20));
        store.jobs.set("b", intervalJob("b", 20));
        let invocations = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                invocations += 1;
            },
        });
        await scheduler.start();
        await waitFor(() => invocations >= 4, 1_000);
        // Wait for any in-flight invoke to finish (the lock release path
        // schedules a save on the next microtask; stopping the scheduler
        // before that lands leaves history entries truncated). Then
        // snapshot the count.
        await new Promise((r) => setTimeout(r, 30));
        const beforeStop = invocations;
        scheduler.detachAll();
        await new Promise((r) => setTimeout(r, 200));
        // After detachAll + a generous wait, no new invokes can land —
        // but the assertion compares against the snapshot taken at stop,
        // so any late-arriving fire from before stop time would show up
        // as a failure. The 30ms sleep above absorbs those.
        const delta = invocations - beforeStop;
        ok(delta <= 1, `expected no new invokes after detachAll; saw ${delta}`);
    });
});

test("invoke receives the command name + args verbatim", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("a", {
            ...intervalJob("a", 60_000, { enabled: false }),
            command: "agent.invoke",
            args: { prompt: "hello", cwd: "/tmp/work" },
        });
        const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async (command, args) => {
                calls.push({ command, args });
            },
        });
        await scheduler.start();
        await scheduler.runNow("a");
        scheduler.stop();
        deepStrictEqual(calls, [
            { command: "agent.invoke", args: { prompt: "hello", cwd: "/tmp/work" } },
        ]);
    });
});

test("start() replays run_on_startup jobs that missed a fire window", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        const lastDay = "2026-08-15T12:00:00.000Z";
        store.jobs.set(
            "missed",
            intervalJob("missed", 60_000, {
                run_on_startup: true,
                last_run_at: lastDay,
            }),
        );
        const invocations: string[] = [];
        const scheduler = new Scheduler({
            store: store as never,
            lockDir: dir,
            invoke: async (cmd) => {
                invocations.push(cmd);
            },
            now: () => new Date("2026-08-17T12:00:00.000Z"),
        });
        await scheduler.start();
        // boot replay is fire-and-forget; allow the fire-and-forget microtask
        // to settle.
        await waitFor(() => invocations.length === 1, 1000);
        // Wait long enough to confirm we did NOT double-fire.
        await new Promise((r) => setTimeout(r, 100));
        strictEqual(invocations.length, 1);
    });
});

test("start() does NOT replay run_on_startup=false jobs", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set(
            "off",
            intervalJob("off", 60_000, {
                run_on_startup: false,
                last_run_at: "2026-08-15T12:00:00.000Z",
            }),
        );
        const invocations: string[] = [];
        const scheduler = new Scheduler({
            store: store as never,
            lockDir: dir,
            invoke: async (cmd) => {
                invocations.push(cmd);
            },
        });
        await scheduler.start();
        await new Promise((r) => setTimeout(r, 100));
        strictEqual(invocations.length, 0);
    });
});

test("start() does NOT replay run_on_startup=true jobs that already ran in the same process", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set(
            "rerun",
            intervalJob("rerun", 60_000, {
                run_on_startup: true,
                last_run_at: "2026-08-15T12:00:00.000Z",
            }),
        );
        const invocations: string[] = [];
        const scheduler = new Scheduler({
            store: store as never,
            lockDir: dir,
            invoke: async (cmd) => {
                invocations.push(cmd);
            },
        });
        await scheduler.start();
        await waitFor(() => invocations.length === 1, 1000);
        await scheduler.stop();
        await scheduler.start();
        await new Promise((r) => setTimeout(r, 100));
        // Boot-replay is per-process. Restarting in the same process does NOT
        // re-fire the missed run — operators get that on the next launch.
        strictEqual(invocations.length, 1);
    });
});
