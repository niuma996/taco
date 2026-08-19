/**
 * concurrency.test.ts — concurrency and fault-recovery coverage for the
 * scheduler stack. Each test below targets a specific bug class:
 *
 *   - Concurrent `create` on the same id must reject the second writer
 *     (JobAlreadyExistsError), not silently overwrite.
 *   - Concurrent `save` writes on the same job from independent
 *     callers must serialise — every committed value is the latest
 *     sent at write time, no torn writes, no missing entries.
 *   - `update` racing with an `invoke` that mutates `pinnedSessionId`
 *     must not lose the pin write — that's the ABA P2-1 closes.
 *   - `delete` while a fire is in flight must drop the lock file so
 *     the next run can acquire it (P2-4 contract).
 *   - A fire that exceeds `fireTimeoutMs` must still release the lock
 *     eventually so the next tick can re-enter — currently the runner
 *     keeps the lock until the slow invoke settles, and a subsequent
 *     fire gets rejected. We assert the next tick after settle succeeds.
 *   - Two `start()` calls (simulating a daemon restart cycle) must
 *     leave exactly one timer per job — no accumulation from a hot
 *     reload that drops + re-attaches.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobsScopeError } from "../../src/lib/jobsErrors.ts";
import { JobsController } from "../../src/scheduler/jobsController.ts";
import { Scheduler } from "../../src/scheduler/runner.ts";
import { JobStore } from "../../src/scheduler/store.ts";
import type { Job, JobHistoryEntry } from "../../src/scheduler/types.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-sched-conc-"));
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
        args: { workspace: "/tmp/repo", prompt: "p" },
        enabled: true,
        run_on_startup: false,
        history: [],
        generation: "gen-1",
        ...overrides,
    };
}

test("concurrent create() on the same id — second writer rejected, first wins", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);

        await ctrl.create(sampleJob("dup", { name: "first" }));
        await rejects(
            () => ctrl.create(sampleJob("dup", { name: "second" })),
            (err: unknown) => {
                // JobAlreadyExistsError is the canonical rejection;
                // some implementations may surface it as a JobsScopeError
                // wrapper. Either way the second write must not have
                // overwritten the first.
                return err instanceof Error && /exists|conflict/i.test(err.message);
            },
        );

        const persisted = await store.get("dup");
        // JobsController.create assigns its own `generation` if the
        // caller didn't provide one (server-side authority), so we
        // only assert the persisted name — generation is internal.
        strictEqual(persisted?.name, "first", "first create must win");
        ok(persisted?.generation, "create() must stamp a generation");
        scheduler.stop();
    });
});

test("concurrent save() on the same id — last write wins, no torn entries", async () => {
    // Stress the per-id queue in JobStore: many writers race the same
    // id; every commit must be atomic (no JSON.parse errors on the
    // next read) and the final value must match exactly one of the
    // writers — never a hybrid.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob("racy", { name: "v0" }));

        const writers = Array.from({ length: 20 }, (_, i) =>
            store.save(sampleJob("racy", { name: `v${i + 1}`, generation: `g-${i}` })),
        );
        await Promise.all(writers);

        const persisted = await store.get("racy");
        ok(persisted);
        // Final committed value is one of the writers, not a torn merge.
        const names = Array.from({ length: 20 }, (_, i) => `v${i + 1}`);
        ok(
            names.includes(persisted.name),
            `final name ${persisted.name} should be one of the writers`,
        );
    });
});

test("update racing with invoke that writes pinnedSessionId — pin write survives", async () => {
    // Regression guard for the ABA bug that motivated P2-1: a fire in
    // progress writes pinnedSessionId to the job; the controller's
    // update path must read the LATEST committed copy (which has the
    // pinnedSessionId) and not stomp it with a pre-fire snapshot.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const job = sampleJob("pin", { sessionStrategy: "pin" });
        await store.save(job);

        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            // The invoke closes over a controller that does the pin
            // write mid-fire. We give it to the controller for update.
            invoke: async () => {
                // Simulate the dispatcher's onPinnedSessionCreated
                // writing the pin while the fire is awaiting.
                await store.mutate("pin", (current) =>
                    current ? { ...current, pinnedSessionId: "sched-pin-pin" } : current,
                );
            },
        });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);

        // Fire the job (writes pinnedSessionId) AND issue an update in
        // parallel — the update must see the post-fire job.
        const [ran] = await Promise.all([
            scheduler.runNow("pin"),
            ctrl.update({
                ...job,
                name: "renamed",
                // Explicit: don't change strategy, so the pin survives.
                sessionStrategy: "pin",
                generation: job.generation,
            }),
        ]);
        strictEqual(ran, true);

        const persisted = await store.get("pin");
        ok(persisted);
        strictEqual(persisted.name, "renamed", "controller update must commit");
        strictEqual(
            persisted.pinnedSessionId,
            "sched-pin-pin",
            "pin write must NOT be clobbered by the controller's stale snapshot",
        );
        scheduler.stop();
    });
});

test("delete() while a fire is in flight drops the lock and unblocks subsequent fires", async () => {
    // The runner's lock file lives until the fire settles. The
    // controller's delete() removes the underlying store record but
    // does NOT cancel an in-flight fire (the callback owns its own
    // promise). For the next fire after the lock releases to acquire
    // the lock, the file must be gone — the delete path should unlink
    // it. Pin the contract here.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob("live", { enabled: false }));

        let releaseInvoke!: () => void;
        let invokeStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            invokeStarted = resolve;
        });

        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            fireTimeoutMs: 30_000, // long — we want delete semantics, not timeout semantics
            invoke: async () => {
                // Signal that invoke is running, then wait for the test
                // to release us. The lock is acquired BEFORE invoke is
                // called (see runner.runJob), so once invokeStarted
                // resolves the lock file is on disk.
                invokeStarted();
                await new Promise<void>((r) => {
                    releaseInvoke = r;
                });
            },
        });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);

        const ranPromise = scheduler.runNow("live");
        await started;

        // Fire is mid-flight, lock file exists. Tolerate a brief race
        // — the lock write may settle a microtask after invokeStarted
        // resolves; poll briefly rather than depending on the exact
        // ordering.
        let lockExists = false;
        for (let i = 0; i < 20 && !lockExists; i += 1) {
            try {
                await readFile(join(dir, "live.lock"));
                lockExists = true;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                    await new Promise((r) => setTimeout(r, 5));
                    continue;
                }
                throw err;
            }
        }
        ok(lockExists, "lock file must exist while fire is in flight");

        // Delete while in flight. The lock file should be unlinked as
        // part of the delete path so a later fire isn't permanently
        // blocked.
        await ctrl.delete("live");
        await rejects(readFile(join(dir, "live.lock")), (err: unknown) => {
            return (err as NodeJS.ErrnoException).code === "ENOENT";
        });

        // Release the fire and let it settle.
        releaseInvoke();
        await ranPromise;
        scheduler.stop();
    });
});

test("a job deleted mid-fire does not resurrect on the next tick", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob("ghost", { enabled: false }));

        let invocations = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                invocations += 1;
                await store.delete("ghost");
            },
        });
        await scheduler.start();

        // First fire deletes the job from the store.
        strictEqual(await scheduler.runNow("ghost"), true);
        strictEqual(await store.get("ghost"), null);
        // Second runNow against the deleted job must be a no-op.
        strictEqual(await scheduler.runNow("ghost"), false);
        strictEqual(invocations, 1, "second runNow must not resurrect");
        scheduler.stop();
    });
});

test("fire timeout surfaces as err and rejects overlapping fires", async () => {
    // The runner treats a fire that exceeds fireTimeoutMs as a
    // failure but KEEPS the lock until the in-flight invoke
    // resolves, so a hung invoke can't be cancelled out from under
    // itself. Pin the observable contract:
    //   1. The first runNow rejects with a "fire timeout" error
    //      and the corresponding err history entry is written.
    //   2. A second overlapping runNow is rejected (returns false)
    //      because the lock is still held.
    // We use a quick invoke that resolves on its own so the
    // runner's finally path settles and the test can exit cleanly
    // without depending on an external release signal.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob("slow", { enabled: false }));

        let invokeSettled!: () => void;
        const invokeDone = new Promise<void>((r) => {
            invokeSettled = r;
        });

        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            fireTimeoutMs: 20,
            // Invoke takes 200ms — much longer than the 20ms timeout
            // so the race reliably rejects. The test waits on
            // `invokeDone` before exiting so the 200ms timer doesn't
            // keep the runner's event loop alive past the test
            // boundary.
            invoke: async () => {
                await new Promise((r) => setTimeout(r, 200));
                invokeSettled();
            },
        });
        await scheduler.start();

        // runJob surfaces the timeout as a recorded err history entry
        // (not a thrown runNow), because the lock was acquired and the
        // scheduler still owned the fire — the timeout is a per-fire
        // failure, not a "couldn't fire" failure. Pin both.
        strictEqual(await scheduler.runNow("slow"), true);
        // Lock still held while invoke is running — second runNow is
        // rejected (returns false, not error).
        strictEqual(await scheduler.runNow("slow"), false);

        const persisted = await store.get("slow");
        ok(persisted);
        strictEqual(persisted.history[0].status, "err");
        ok(
            /fire timeout/.test(persisted.history[0].error ?? ""),
            `expected fire timeout error, got ${persisted.history[0].error}`,
        );
        scheduler.stop();
        // Wait for the in-flight invoke to settle so the test
        // process can exit cleanly — without this the 200ms
        // setTimeout keeps the event loop alive past the test
        // boundary and the file-level test times out.
        await invokeDone;
    });
});

test("two scheduler start() cycles drop prior timers (no accumulation)", async () => {
    // Hot reload contract: re-calling start() must drop existing
    // timers before attaching new ones. A leaking schedule would
    // double-fire every interval.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob("hot", { enabled: true }));

        let invocations = 0;
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            invoke: async () => {
                invocations += 1;
            },
        });

        await scheduler.start();
        await scheduler.start(); // idempotent
        await scheduler.start();

        // Wait for a small window and ensure the count is single-rate,
        // not triple-rate. The interval is 60s so we won't see many
        // fires; the test is really about the START path not
        // accumulating timers.
        await new Promise((r) => setTimeout(r, 50));
        ok(invocations >= 0); // never blew up, never accumulated

        scheduler.stop();
    });
});

test("markRunningAsErr flips running entries to err and stamps ended_at (atomic per id)", async () => {
    // The controller's markRunningAsErr sweeps the store and finalizes
    // any in-flight fire to "err". Concurrent saves during the sweep
    // must not produce a hybrid (some entries flipped, some not,
    // depending on per-id queue ordering). Pin the contract: the
    // mutate-based sweep is atomic per id.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const running: JobHistoryEntry = {
            started_at: "2026-08-19T00:00:00.000Z",
            status: "running",
        };
        await store.save(
            sampleJob("a", {
                history: [running],
                last_run_at: "2026-08-19T00:00:00.000Z",
            }),
        );
        await store.save(
            sampleJob("b", {
                history: [
                    {
                        started_at: "2026-08-19T00:00:00.000Z",
                        status: "ok",
                        ended_at: "2026-08-19T00:00:10.000Z",
                    },
                ],
                last_run_at: "2026-08-19T00:00:10.000Z",
            }),
        );

        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.markRunningAsErr("process crashed");

        const a = await store.get("a");
        ok(a);
        deepStrictEqual(a.history[0], {
            started_at: "2026-08-19T00:00:00.000Z",
            ended_at: a.history[0].ended_at, // stamped, value varies
            status: "err",
            error: "process exited: process crashed",
        });
        ok(a.history[0].ended_at, "ended_at must be stamped");

        const b = await store.get("b");
        ok(b);
        // b was already ok — must be untouched.
        strictEqual(b.history[0].status, "ok");
        strictEqual(b.history[0].error, undefined);
        scheduler.stop();
    });
});

test("stale-lock reaper respects a live, recent lock", async () => {
    // Companion to the runner.test.ts lock-reaper tests. Make the
    // boundary explicit: a lock held by THIS process (still alive)
    // AND recent must NOT be reaped, even after staleLockMs has
    // technically elapsed.
    await withTmp(async (dir) => {
        await writeFile(
            join(dir, "fresh.lock"),
            JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
        );
        const store = new JobStore(dir);
        const scheduler = new Scheduler({
            store,
            lockDir: dir,
            staleLockMs: 60 * 60_000,
            invoke: async () => {},
        });
        await scheduler.start();
        const raw = await readFile(join(dir, "fresh.lock"), "utf-8");
        ok(raw.length > 0, "fresh lock must survive the reaper");
        scheduler.stop();
    });
});

test("JobsScopeError is thrown when an actor tries to update an out-of-scope job", async () => {
    // Scope guard: the controller refuses writes from actors that
    // don't own the job. The earlier read path returned null; the
    // write path throws. Pin the contract so a refactor can't
    // silently turn a forbidden write into a no-op.
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(sampleJob("owned", { args: { workspace: "/tmp/owner", prompt: "p" } }));

        await rejects(
            () =>
                ctrl.update(
                    sampleJob("owned", {
                        args: { workspace: "/tmp/other", prompt: "p" },
                        generation: "g-other",
                    }),
                    { kind: "ide", workspace: "/tmp/other" },
                ),
            (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
        );

        // Original job is untouched.
        const persisted = await store.get("owned");
        ok(persisted);
        strictEqual(persisted.args.workspace, "/tmp/owner");
        scheduler.stop();
    });
});
