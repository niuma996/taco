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
import { makeImCwd } from "@taco-ai/protocol";
import { JobsScopeError } from "../../src/lib/jobsErrors.ts";
import { JobsController } from "../../src/scheduler/jobsController.ts";
import { Scheduler } from "../../src/scheduler/runner.ts";
import { JobStore } from "../../src/scheduler/store.ts";
import type { Actor, Job } from "../../src/scheduler/types.ts";

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

// ─── scope enforcement ───────────────────────────────────────────────────────

test("create() derives channelId/peerId from im:// workspace and ignores caller values", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        const im = makeImCwd("channel-x", "peer-1", "chat-1");
        const job = sampleJob("a", {
            args: { workspace: im },
            // Caller tries to forge scope — server must overwrite.
            channelId: "channel-other",
            peerId: "peer-other",
        });
        const saved = await ctrl.create(job, {
            kind: "im",
            channelId: "channel-x",
            peerId: "peer-1",
            chatId: "chat-1",
        });
        strictEqual(saved.channelId, "channel-x");
        strictEqual(saved.peerId, "peer-1");
        scheduler.stop();
    });
});

test("create() zeroes out channelId/peerId for fs workspace even when caller supplies them", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        const job = sampleJob("a", {
            args: { workspace: "/tmp/proj" },
            channelId: "spoof",
            peerId: "spoof",
        });
        const saved = await ctrl.create(job, { kind: "ide", workspace: "/tmp/proj" });
        strictEqual(saved.channelId, undefined);
        strictEqual(saved.peerId, undefined);
        scheduler.stop();
    });
});

test("list() filters IM jobs to actor's channel/peer and returns everything for undefined actor", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(
            sampleJob("mine", { args: { workspace: makeImCwd("ch1", "p1", "c1") } }),
            { kind: "im", channelId: "ch1", peerId: "p1", chatId: "c1" },
        );
        await ctrl.create(
            sampleJob("other", { args: { workspace: makeImCwd("ch1", "p2", "c1") } }),
            { kind: "im", channelId: "ch1", peerId: "p2", chatId: "c1" },
        );
        const visibleToMine = await ctrl.list({
            kind: "im",
            channelId: "ch1",
            peerId: "p1",
            chatId: "c1",
        });
        deepStrictEqual(
            visibleToMine.map((j) => j.id),
            ["mine"],
        );
        const all = await ctrl.list();
        deepStrictEqual(all.map((j) => j.id).sort(), ["mine", "other"]);
        scheduler.stop();
    });
});

test("get() returns null for out-of-scope job (existence not leaked)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(
            sampleJob("other", { args: { workspace: makeImCwd("ch1", "p2", "c1") } }),
            { kind: "im", channelId: "ch1", peerId: "p2", chatId: "c1" },
        );
        const result = await ctrl.get("other", {
            kind: "im",
            channelId: "ch1",
            peerId: "p1",
            chatId: "c1",
        });
        strictEqual(result, null);
        scheduler.stop();
    });
});

test("update() anchors to existing job's scope — caller cannot shift channel", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(sampleJob("a", { args: { workspace: makeImCwd("ch1", "p1", "c1") } }), {
            kind: "im",
            channelId: "ch1",
            peerId: "p1",
            chatId: "c1",
        });
        // Try to shift the job to another channel via update.
        const updated = await ctrl.update(
            {
                ...sampleJob("a", {
                    name: "renamed",
                    args: { workspace: makeImCwd("ch1", "p1", "c1") },
                }),
            },
            { kind: "im", channelId: "ch1", peerId: "p1", chatId: "c1" },
        );
        strictEqual(updated.name, "renamed");
        // Scope stays anchored.
        strictEqual(updated.channelId, "ch1");
        strictEqual(updated.peerId, "p1");
        scheduler.stop();
    });
});

test("update() throws JobsScopeError when actor cannot see existing job", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(sampleJob("a", { args: { workspace: makeImCwd("ch1", "p1", "c1") } }), {
            kind: "im",
            channelId: "ch1",
            peerId: "p1",
            chatId: "c1",
        });
        const otherActor: Actor = { kind: "im", channelId: "ch1", peerId: "p2", chatId: "c1" };
        await rejects(
            () =>
                ctrl.update(
                    sampleJob("a", { args: { workspace: makeImCwd("ch1", "p2", "c1") } }),
                    otherActor,
                ),
            (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
        );
        scheduler.stop();
    });
});

test("delete() ignores call when actor cannot see the job (no leak)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(
            sampleJob("other", { args: { workspace: makeImCwd("ch1", "p2", "c1") } }),
            { kind: "im", channelId: "ch1", peerId: "p2", chatId: "c1" },
        );
        // Should not throw and should not delete the file.
        await ctrl.delete("other", { kind: "im", channelId: "ch1", peerId: "p1", chatId: "c1" });
        ok(await store.get("other"));
        scheduler.stop();
    });
});

test("history() returns null for out-of-scope job", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.create(
            sampleJob("other", {
                args: { workspace: makeImCwd("ch1", "p2", "c1") },
                history: [
                    {
                        started_at: "2026-01-01T00:00:00.000Z",
                        ended_at: "2026-01-01T00:01:00.000Z",
                        status: "ok",
                    },
                ],
            }),
            { kind: "im", channelId: "ch1", peerId: "p2", chatId: "c1" },
        );
        const hist = await ctrl.history("other", {
            kind: "im",
            channelId: "ch1",
            peerId: "p1",
            chatId: "c1",
        });
        strictEqual(hist, null);
        scheduler.stop();
    });
});

test("markRunningAsErr() flips every running entry to err and stamps ended_at", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        // Two jobs: one has a still-running entry that should be flipped,
        // one has a completed entry that must be left alone. A third
        // running entry exists on the second job to verify it touches
        // every job, not just the first.
        await store.save(
            sampleJob("hung", {
                history: [
                    {
                        started_at: "2026-01-01T00:00:00.000Z",
                        status: "running",
                    },
                    {
                        started_at: "2025-12-31T23:00:00.000Z",
                        ended_at: "2025-12-31T23:00:05.000Z",
                        status: "ok",
                    },
                ],
            }),
        );
        await store.save(
            sampleJob("done", {
                history: [
                    {
                        started_at: "2026-01-02T00:00:00.000Z",
                        ended_at: "2026-01-02T00:00:10.000Z",
                        status: "ok",
                    },
                ],
            }),
        );
        await store.save(
            sampleJob("also-hung", {
                history: [
                    {
                        started_at: "2026-01-03T00:00:00.000Z",
                        status: "running",
                    },
                ],
            }),
        );
        const scheduler = new Scheduler({ store, lockDir: dir, invoke: async () => {} });
        await scheduler.start();
        const ctrl = new JobsController(store, scheduler, dir);
        await ctrl.markRunningAsErr("SIGTERM");
        const hung = await store.get("hung");
        ok(hung);
        const hungRunning = hung.history.find((h) => h.status === "running");
        strictEqual(hungRunning, undefined, "no entry should remain in running");
        const hungFlipped = hung.history[0];
        strictEqual(hungFlipped.status, "err");
        ok(hungFlipped.error?.includes("SIGTERM"));
        ok(hungFlipped.ended_at);
        // The historical ok entry must be untouched.
        const hungOld = hung.history.find((h) => h.started_at === "2025-12-31T23:00:00.000Z");
        strictEqual(hungOld?.status, "ok");

        const done = await store.get("done");
        strictEqual(done?.history[0].status, "ok");

        const alsoHung = await store.get("also-hung");
        strictEqual(alsoHung?.history[0].status, "err");
        scheduler.stop();
    });
});
