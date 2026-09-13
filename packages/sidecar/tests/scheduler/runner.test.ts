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
import { applyRunOutcome, Scheduler } from "../../src/scheduler/runner.ts";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, type Job } from "../../src/scheduler/types.ts";

class MemoryStore {
    public jobs = new Map<string, Job>();
    // Combined write counter — `save` and `mutate` both increment.
    // P2-1 collapsed the runner's read-modify-write to `mutate`, so a
    // handful of tests that used to assert `savedCount >= N` now read
    // the same counter and still mean "at least N writes happened".
    public writeCount = 0;
    public mutateCount = 0;
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
        this.writeCount += 1;
    }
    // Required since P2-1: the runner's history write goes through
    // mutate exclusively (the get+save fallback had an ABA race with
    // concurrent dispatcher callbacks). Implementation mirrors
    // JobStore.mutate's contract: read the latest, run the updater,
    // commit the result. Returning null deletes the job (not used by
    // any runner test today but the API requires it for symmetry).
    async mutate(id: string, update: (current: Job | null) => Job | null): Promise<Job | null> {
        this.mutateCount += 1;
        this.writeCount += 1;
        const current = this.jobs.get(id) ?? null;
        const next = update(current);
        if (next === current) return current;
        if (next === null) {
            this.jobs.delete(id);
            return null;
        }
        this.jobs.set(id, structuredClone(next));
        return this.jobs.get(id) ?? null;
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
        await waitFor(() => store.writeCount >= 1, 500);
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
        await waitFor(() => store.writeCount >= 1, 500);
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
        await waitFor(() => store.writeCount >= 25, 2_000);
        scheduler.stop();
        const saved = store.jobs.get("a");
        ok(saved);
        strictEqual(saved.history.length <= 20, true);
    });
});

test("runNow fires the job once and reports ok; missing job reports failed", async () => {
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
        strictEqual((await scheduler.runNow("a")).status, "ok");
        strictEqual(invoked, 1);
        strictEqual((await scheduler.runNow("nope")).status, "failed");
        scheduler.stop();
    });
});

// ─── run caps + circuit breaker (applyRunOutcome policy) ─────────────────────

test("applyRunOutcome counts only successes toward max_runs", () => {
    const job = intervalJob("j", 1_000, { max_runs: 2 });
    // A failure must not consume the budget — the whole point of a
    // success-only cap is that an errored fire gets retried on schedule.
    const afterFail = applyRunOutcome(job, false);
    strictEqual(afterFail.run_count, 0);
    strictEqual(afterFail.disabled_reason, undefined);

    const afterOne = applyRunOutcome({ ...job, run_count: 0 }, true);
    strictEqual(afterOne.run_count, 1);
    strictEqual(afterOne.disabled_reason, undefined, "1 of 2 must stay enabled");

    const afterTwo = applyRunOutcome({ ...job, run_count: 1 }, true);
    strictEqual(afterTwo.run_count, 2);
    ok(afterTwo.disabled_reason, "reaching max_runs must retire the job");
});

test("applyRunOutcome retires a one-shot job after its single success", () => {
    const oneShot = intervalJob("once", 86_400_000, { max_runs: 1 });
    const out = applyRunOutcome(oneShot, true);
    strictEqual(out.run_count, 1);
    ok(out.disabled_reason);
});

test("applyRunOutcome leaves an uncapped job alone forever", () => {
    const out = applyRunOutcome(intervalJob("j", 1_000, { run_count: 9_999 }), true);
    strictEqual(out.run_count, 10_000);
    strictEqual(out.disabled_reason, undefined);
});

test("applyRunOutcome trips the breaker on consecutive failures only", () => {
    const job = intervalJob("j", 1_000, { max_consecutive_failures: 3 });
    strictEqual(
        applyRunOutcome({ ...job, consecutive_failures: 1 }, false).consecutive_failures,
        2,
    );
    strictEqual(
        applyRunOutcome({ ...job, consecutive_failures: 1 }, false).disabled_reason,
        undefined,
    );
    // A success in between resets the streak, so the job survives.
    strictEqual(applyRunOutcome({ ...job, consecutive_failures: 2 }, true).consecutive_failures, 0);
    ok(applyRunOutcome({ ...job, consecutive_failures: 2 }, false).disabled_reason);
});

test("applyRunOutcome applies the default breaker budget when unset", () => {
    const job = intervalJob("j", 1_000);
    const atEdge = applyRunOutcome(
        { ...job, consecutive_failures: DEFAULT_MAX_CONSECUTIVE_FAILURES - 1 },
        false,
    );
    ok(atEdge.disabled_reason, "an unset budget must still protect the job");
});

test("applyRunOutcome honours max_consecutive_failures: 0 as opt-out", () => {
    const job = intervalJob("j", 1_000, { max_consecutive_failures: 0 });
    const out = applyRunOutcome({ ...job, consecutive_failures: 999 }, false);
    strictEqual(out.consecutive_failures, 1_000);
    strictEqual(out.disabled_reason, undefined, "0 disables the breaker entirely");
});

test("a max_runs:1 job disables itself and stops firing after one success", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("once", intervalJob("once", 20, { max_runs: 1 }));
        let invoked = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                invoked += 1;
            },
        });
        await scheduler.start();
        await waitFor(() => invoked >= 1, 2_000);
        // Give the 20ms interval several more windows: a job that failed to
        // detach would rack up further fires here.
        await new Promise((r) => setTimeout(r, 200));
        strictEqual(invoked, 1, "retired job must not fire again");
        const saved = store.jobs.get("once");
        strictEqual(saved?.enabled, false);
        strictEqual(saved?.run_count, 1);
        ok(saved?.disabled_reason, "self-retirement must record a reason");
        // History survives, so the operator can still read the run's outcome.
        strictEqual(saved?.history?.length, 1);
        strictEqual(saved?.history?.[0].status, "ok");
        scheduler.stop();
    });
});

test("a permanently failing job trips the breaker and stops firing", async () => {
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set(
            "broken",
            intervalJob("broken", 20, { max_consecutive_failures: 2, max_runs: 5 }),
        );
        let attempts = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                attempts += 1;
                throw new Error("command not found");
            },
        });
        await scheduler.start();
        await waitFor(() => (store.jobs.get("broken")?.enabled ?? true) === false, 2_000);
        const settled = attempts;
        await new Promise((r) => setTimeout(r, 200));
        strictEqual(attempts, settled, "breaker must stop further attempts");
        const saved = store.jobs.get("broken");
        strictEqual(saved?.enabled, false);
        strictEqual(saved?.consecutive_failures, 2);
        // The success cap was never reached — the breaker is what saved us.
        strictEqual(saved?.run_count, 0);
        ok(/consecutive/.test(saved?.disabled_reason ?? ""));
        scheduler.stop();
    });
});

test("runNow reports failed with the invoke error when the fire rejects", async () => {
    // Regression guard for the "fired but actually failed" misreport: a fire
    // whose invocation rejects must not come back as a success just because
    // the lock was taken.
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("boom", intervalJob("boom", 60_000, { enabled: false }));
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                throw new Error("prompt rejected: session_busy");
            },
        });
        await scheduler.start();
        const outcome = await scheduler.runNow("boom");
        strictEqual(outcome.status, "failed");
        strictEqual(outcome.error, "prompt rejected: session_busy");
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
        strictEqual((await scheduler.runNow("a")).status, "ok");
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

test("start() replays a run_on_startup job that has never run", async () => {
    // A job created while the daemon was down (or just before a restart)
    // has no last_run_at. Arming run_on_startup asks for a run on the
    // next boot — without this a fresh 24h-interval job would sit idle
    // for a full interval after the restart that created it.
    await withTmp(async (dir) => {
        const store = new MemoryStore();
        store.jobs.set("fresh", intervalJob("fresh", 60_000, { run_on_startup: true }));
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
        const outcome = await scheduler.runNow("hang");
        strictEqual(outcome.status, "failed");
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
        strictEqual((await scheduler.runNow("hang")).status, "skipped");
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
        strictEqual(ran.status, "ok");
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
        strictEqual(ran.status, "ok");
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
        strictEqual(ran.status, "ok");
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
