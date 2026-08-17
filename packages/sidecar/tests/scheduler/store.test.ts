/**
 * JobStore round-trip + atomicity tests. Uses a per-test tmpdir so the
 * suite is parallel-safe and leaves no state behind.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvalidJobIdError } from "../../src/scheduler/jobId.ts";
import { JobStore } from "../../src/scheduler/store.ts";
import type { Job } from "../../src/scheduler/types.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-scheduler-test-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function sampleJob(overrides: Partial<Job> = {}): Job {
    return {
        id: "abc-123",
        name: "nightly-cleanup",
        schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
        command: "agent.invoke",
        args: { prompt: "wipe /tmp/scratch" },
        enabled: true,
        run_on_startup: false,
        history: [],
        ...overrides,
    };
}

test("save + get round-trip preserves all fields", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const job = sampleJob();
        await store.save(job);
        const round = await store.get(job.id);
        deepStrictEqual(round, job);
    });
});

test("list returns jobs sorted by id (stable UI order)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob({ id: "zzz" }));
        await store.save(sampleJob({ id: "aaa" }));
        await store.save(sampleJob({ id: "mmm" }));
        const ids = (await store.list()).map((j) => j.id);
        deepStrictEqual(ids, ["aaa", "mmm", "zzz"]);
    });
});

test("save overwrites the existing file atomically (no leftover .tmp)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob({ name: "first" }));
        await store.save(sampleJob({ name: "second" }));
        const round = await store.get("abc-123");
        strictEqual(round?.name, "second");
        // .tmp must not survive a successful save — leaving it behind would
        // suggest a half-finished write that future saves would clobber.
        const tmpPath = join(dir, "abc-123.json.tmp");
        await rejects(stat(tmpPath), /ENOENT/);
    });
});

test("delete is idempotent: missing files don't throw", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.delete("does-not-exist");
        await store.save(sampleJob());
        await store.delete("abc-123");
        strictEqual(await store.get("abc-123"), null);
    });
});

test("list ignores malformed job files but keeps valid ones", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.save(sampleJob({ id: "good" }));
        await store.ensureDir();
        await writeBad(dir, "bad.json", "{not-json");
        const jobs = await store.list();
        deepStrictEqual(
            jobs.map((j) => j.id),
            ["good"],
        );
    });
});

test("save persists history entries verbatim (no implicit truncation)", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        const entries = Array.from({ length: 25 }, (_, i) => ({
            started_at: `2026-01-${(i + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
            ended_at: `2026-01-${(i + 1).toString().padStart(2, "0")}T00:01:00.000Z`,
            status: "ok" as const,
        }));
        await store.save(sampleJob({ history: entries }));
        const round = await store.get("abc-123");
        // The store is dumb storage — the HISTORY_LIMIT cap is enforced by
        // the runner, not here. We test that the cap is NOT silently
        // applied at the persistence layer (otherwise the runner's
        // truncation would race with re-reads on reload).
        strictEqual(round?.history.length, 25);
    });
});

test("JobStore rejects traversal IDs even when no RPC layer is involved", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await rejects(
            () =>
                store.save({
                    id: "../escape",
                    name: "x",
                    schedule: { kind: "interval", ms: 1000 },
                    command: "agent.invoke",
                    args: {},
                    enabled: true,
                    run_on_startup: false,
                    history: [],
                }),
            (e: unknown) => e instanceof InvalidJobIdError,
        );
        await rejects(
            () => store.get("../escape"),
            (e: unknown) => e instanceof InvalidJobIdError,
        );
        await rejects(
            () => store.delete("../escape"),
            (e: unknown) => e instanceof InvalidJobIdError,
        );
    });
});

test("JobStore.list filters tampered entries whose basenames are not safe IDs", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await writeFile(join(dir, "good-id.json"), JSON.stringify({ id: "good-id" }));
        await writeFile(join(dir, "../escape.json"), JSON.stringify({ id: "../escape" }));
        await writeFile(join(dir, "not-json"), "garbage");
        const jobs = await store.list();
        strictEqual(jobs.length, 1);
        strictEqual(jobs[0].id, "good-id");
    });
});

async function writeBad(dir: string, name: string, contents: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, name), contents, "utf8");
    ok(true);
}

void readFile; // keep import live for symmetry with other tests that may add file reads later
