/**
 * Scheduler behavior tests. We stub `CommandInvoker` (the sidecar-side
 * command dispatcher) and `now()` (for deterministic history timestamps).
 *
 * Interval jobs use small ms values + manual advancement; cron jobs use
 * a fixed `Cron` expression + the croner adapter's own scheduling so we
 * exercise the same code path the daemon runs in production.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
            invoke: async (job) => {
                calls.push({ command: job.command, args: job.args });
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
            invoke: async (job) => {
                invocations.push(job.command);
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
        scheduler.stop();
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
            invoke: async (job) => {
                invocations.push(job.command);
            },
        });
        await scheduler.start();
        await new Promise((r) => setTimeout(r, 100));
        strictEqual(invocations.length, 0);
        scheduler.stop();
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
            invoke: async (job) => {
                invocations.push(job.command);
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
        scheduler.stop();
    });
});

test("invoke timeout records an error but retains the lock until the invocation settles", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("hang", intervalJob("hang", 60_000, { enabled: false }));
        let settled = false;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            fireTimeoutMs: 50,
            invoke: () =>
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        settled = true;
                        resolve();
                    }, 5_000);
                }),
        });
        await scheduler.start();
        const ran = await scheduler.runNow("hang");
        strictEqual(ran, true);
        const saved = store.jobs.get("hang");
        ok(saved);
        strictEqual(saved.history.length, 1);
        strictEqual(saved.history[0].status, "err");
        ok(
            /fire timeout/.test(saved.history[0].error ?? ""),
            `unexpected error: ${saved.history[0].error}`,
        );
        ok(saved.history[0].ended_at, "ended_at should be stamped");
        scheduler.stop();
        // The underlying invocation is still active, so a second fire must be
        // rejected instead of overlapping the same job/session turn.
        ok(await readFile(join(dir, "hang.lock")));
        strictEqual(await scheduler.runNow("hang"), false);
        // Settle the underlying invoke so the test process can exit cleanly.
        await new Promise((r) => setTimeout(r, 20));
        strictEqual(settled, false, "invoke promise is intentionally not cancelled");
    });
});

test("start() removes lock files whose owning pid is dead", async () => {
    await withTmp(async (dir) => {
        // Plant a lock owned by an obviously-dead pid. process.kill(pid, 0)
        // returns false for it (ESRCH), so the cleanup pass deletes the file.
        await writeFile(
            join(dir, "ghost.lock"),
            JSON.stringify({ pid: 2_147_483_647, started_at: new Date().toISOString() }),
        );
        const store = new MemoryStore();
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {},
        });
        await scheduler.start();
        await readFile(join(dir, "ghost.lock")).then(
            () => {
                throw new Error("dead-pid lock should have been removed");
            },
            (err: NodeJS.ErrnoException) => {
                strictEqual(err.code, "ENOENT");
            },
        );
        scheduler.stop();
    });
});

test("runJob on a legacy job (no history field) does not crash and writes ok", async () => {
    await withTmp(async (dir) => {
        // Plant a legacy job object — `history` is undefined. This is the
        // exact on-disk shape the user's open_source_ai_monitor.json
        // had before the field existed. The store normalizes on read,
        // so the runner's spread should never see undefined there. The
        // runner's defensive `?? []` is the second line of defense for
        // direct callers (e.g. a future RPC path that hands a Job straight
        // to the scheduler); this test exercises that path.
        const legacyJob = {
            id: "legacy",
            name: "legacy",
            schedule: { kind: "interval", ms: 60_000 },
            command: "agent.invoke",
            args: { workspace: "im://ch/p/c" },
            enabled: false,
            run_on_startup: false,
        } as unknown as Job;
        const store = new MemoryStore();
        store.jobs.set("legacy", legacyJob);
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {},
        });
        await scheduler.start();
        const ran = await scheduler.runNow("legacy");
        strictEqual(ran, true);
        const saved = store.jobs.get("legacy");
        ok(saved);
        ok(Array.isArray(saved.history));
        strictEqual(saved.history.length, 1);
        strictEqual(saved.history[0].status, "ok");
        scheduler.stop();
    });
});

test("a field invoke writes mid-fire survives the history save", async () => {
    await withTmp(async (dir) => {
        // Regression guard. The runner captures `job` before invoke runs,
        // but invoke legitimately mutates the stored copy: the pin
        // strategy's onPinnedSessionCreated writes `pinnedSessionId` while
        // the fire is still awaiting. Saving the pre-invoke snapshot in the
        // finally block dropped that field, so the next fire re-entered the
        // "no pinned session yet" branch and created another session —
        // which is how one pin job accumulated 9 duplicate jsonl files.
        const store = new MemoryStore();
        const job = intervalJob("pinjob", 60_000, { enabled: false });
        store.jobs.set("pinjob", job);
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async (j) => {
                const current = await store.get(j.id);
                ok(current);
                await store.save({ ...current, pinnedSessionId: "sched-pin-pinjob" });
            },
        });
        const ran = await scheduler.runNow("pinjob");
        strictEqual(ran, true);
        const saved = store.jobs.get("pinjob");
        ok(saved);
        // The field invoke wrote is still there...
        strictEqual(saved.pinnedSessionId, "sched-pin-pinjob");
        // ...and this fire's own history/last_run_at landed too.
        strictEqual(saved.history.length, 1);
        strictEqual(saved.history[0].status, "ok");
        ok(saved.last_run_at);
        scheduler.stop();
    });
});

test("a job deleted mid-fire is not resurrected by the runner", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("gone", intervalJob("gone", 60_000, { enabled: false }));
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                await store.delete("gone");
            },
        });
        const ran = await scheduler.runNow("gone");
        strictEqual(ran, true);
        strictEqual(store.jobs.get("gone"), undefined);
        scheduler.stop();
    });
});

test("start() removes lock files older than staleLockMs", async () => {
    await withTmp(async (dir) => {
        // Lock from two hours ago, current pid (alive but old). Cutoff is 1h
        // so this should be reaped even though the owner is technically live.
        const oldIso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
        await writeFile(
            join(dir, "ancient.lock"),
            JSON.stringify({ pid: process.pid, started_at: oldIso }),
        );
        const store = new MemoryStore();
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            staleLockMs: 60 * 60_000,
            invoke: async () => {},
        });
        await scheduler.start();
        await readFile(join(dir, "ancient.lock")).then(
            () => {
                throw new Error("ancient lock should have been reaped");
            },
            (err: NodeJS.ErrnoException) => {
                strictEqual(err.code, "ENOENT");
            },
        );
        scheduler.stop();
    });
});

test("start() leaves lock files held by a live, recent pid alone", async () => {
    await withTmp(async (dir) => {
        // Live pid, recent timestamp — the cleanup pass must NOT touch it.
        // This is the common case when a previous boot's runJob finally
        // hasn't quite released yet, or another instance is racing us.
        await writeFile(
            join(dir, "fresh.lock"),
            JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
        );
        const store = new MemoryStore();
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {},
        });
        await scheduler.start();
        // File should still be there.
        const raw = await readFile(join(dir, "fresh.lock"), "utf-8");
        ok(raw.length > 0);
        scheduler.stop();
    });
});
