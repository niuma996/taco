/**
 * JobStore round-trip + atomicity tests. Uses a per-test tmpdir so the
 * suite is parallel-safe and leaves no state behind.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobAlreadyExistsError } from "../../src/lib/jobsErrors.ts";
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

test("concurrent saves for one job serialize without temp-file collisions", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
                store.save(sampleJob({ name: `write-${index}` })),
            ),
        );
        const saved = await store.get("abc-123");
        ok(saved);
        ok(/^write-\d+$/.test(saved.name));
    });
});

test("create is exclusive and never overwrites an existing job", async () => {
    await withTmp(async (dir) => {
        const store = new JobStore(dir);
        await store.create(sampleJob({ name: "first" }));
        await rejects(
            () => store.create(sampleJob({ name: "second" })),
            (err: unknown) => err instanceof JobAlreadyExistsError,
        );
        strictEqual((await store.get("abc-123"))?.name, "first");
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

test("get() normalizes a legacy job file (no history field) to an empty array", async () => {
    await withTmp(async (dir) => {
        // Plant a job file exactly as the user-facing open_source_ai_monitor
        // looked on disk: every current field, no `history`. The store is
        // the canonical layer where this gets normalized so the runner's
        // `[entry, ...job.history]` spread never sees undefined.
        const legacy = {
            id: "legacy",
            name: "legacy",
            schedule: { kind: "interval", ms: 60_000 },
            command: "agent.invoke",
            args: { workspace: "im://ch/p/c" },
            enabled: true,
            run_on_startup: false,
            sessionStrategy: "pin",
            channelId: "ch",
            peerId: "p",
        };
        await writeFile(join(dir, "legacy.json"), JSON.stringify(legacy));
        const store = new JobStore(dir);
        const loaded = await store.get("legacy");
        ok(loaded);
        deepStrictEqual(loaded.history, []);
        // All other fields survive untouched.
        strictEqual(loaded.id, "legacy");
        strictEqual(loaded.sessionStrategy, "pin");
        strictEqual(loaded.channelId, "ch");
    });
});

test("list() normalizes legacy job files identical to get()", async () => {
    await withTmp(async (dir) => {
        await writeFile(
            join(dir, "legacy.json"),
            JSON.stringify({
                id: "legacy",
                name: "legacy",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { workspace: "im://ch/p/c" },
                enabled: true,
                run_on_startup: false,
            }),
        );
        const store = new JobStore(dir);
        const jobs = await store.list();
        strictEqual(jobs.length, 1);
        strictEqual(jobs[0].history?.length, 0);
    });
});

test("get() migrates a legacy shell-style command into agent.invoke + args.prompt", async () => {
    await withTmp(async (dir) => {
        // Job files written before the `agent.invoke`-only check landed
        // put the task in `command` (e.g. `command: "mmx search query"`)
        // instead of `args.prompt`. The store is the canonical boundary
        // between the loose on-disk format and the in-memory Job contract,
        // so we bridge the gap here — by the time the dispatcher or jobs
        // handler sees the job, `command` is `agent.invoke` and the
        // original intent is in `args.prompt`.
        const legacy = {
            id: "legacy",
            name: "legacy",
            schedule: { kind: "interval", ms: 60_000 },
            command: "mmx search query",
            args: {
                q: "github trending open source AI project today 2026",
                output: "json",
                quiet: "",
                workspace: "im://ch/p/c",
            },
            enabled: true,
            run_on_startup: false,
        };
        await writeFile(join(dir, "legacy.json"), JSON.stringify(legacy));
        const store = new JobStore(dir);
        const loaded = await store.get("legacy");
        ok(loaded);
        strictEqual(loaded.command, "agent.invoke");
        strictEqual(
            typeof loaded.args.prompt === "string" &&
                loaded.args.prompt.startsWith("mmx search query"),
            true,
        );
        // The legacy `q` value lands in the prompt verbatim; the agent has
        // enough context to run the same query.
        const prompt = String(loaded.args.prompt ?? "");
        ok(prompt.includes("github trending open source AI project today 2026"));
        // workspace survives the migration verbatim.
        strictEqual(loaded.args.workspace, "im://ch/p/c");
        // Noise flags are dropped from the prompt so the agent's view is
        // focused on intent rather than echoing shell syntax.
        ok(!prompt.includes("--output"));
    });
});

test("get() leaves agent.invoke jobs untouched (no migration artifact)", async () => {
    await withTmp(async (dir) => {
        await writeFile(
            join(dir, "fresh.json"),
            JSON.stringify({
                id: "fresh",
                name: "fresh",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { workspace: "/tmp/repo", prompt: "summarize the latest commits" },
                enabled: true,
                run_on_startup: false,
            }),
        );
        const store = new JobStore(dir);
        const loaded = await store.get("fresh");
        ok(loaded);
        strictEqual(loaded.command, "agent.invoke");
        // The original prompt comes through verbatim — no migration rewrites
        // a job the user already shaped correctly.
        strictEqual(loaded.args.prompt, "summarize the latest commits");
    });
});

test("get() leaves a legacy job with empty command alone (dispatcher rejects it later)", async () => {
    await withTmp(async (dir) => {
        // Empty / non-string command values are unrecognizable legacy
        // payloads. Better to let the dispatcher's
        // UnsupportedScheduledCommand surface them on the next fire than
        // to silently drop a job the user actually wanted.
        await writeFile(
            join(dir, "empty.json"),
            JSON.stringify({
                id: "empty",
                name: "empty",
                schedule: { kind: "interval", ms: 60_000 },
                command: "",
                args: { workspace: "/tmp/repo" },
                enabled: true,
                run_on_startup: false,
            }),
        );
        const store = new JobStore(dir);
        const loaded = await store.get("empty");
        ok(loaded);
        strictEqual(loaded.command, "");
    });
});

test("get() persists the migrated agent.invoke form back to disk", async () => {
    await withTmp(async (dir) => {
        // A legacy file on disk → after `get` returns the migrated form,
        // the file should converge to the canonical shape so subsequent
        // reads (and any daemon restart with an older bundle) see the
        // same data the UI now shows. Otherwise the UI keeps displaying
        // the legacy `command` until something else triggers a save.
        await writeFile(
            join(dir, "legacy.json"),
            JSON.stringify({
                id: "legacy",
                name: "legacy",
                schedule: { kind: "interval", ms: 300_000 },
                command: "mmx search query",
                args: {
                    q: "github trending open source AI project today 2026",
                    workspace: "im://ch/p/c",
                },
                enabled: true,
                run_on_startup: false,
            }),
        );
        const store = new JobStore(dir);
        const loaded = await store.get("legacy");
        ok(loaded);
        strictEqual(loaded.command, "agent.invoke");

        // The save is fire-and-forget; wait a microtask for the rename
        // to settle before we re-read the file from disk.
        await Promise.resolve();
        await Promise.resolve();
        const raw = await readFile(join(dir, "legacy.json"), "utf8");
        const onDisk = JSON.parse(raw);
        // The on-disk form is the canonical one — a re-read will hit the
        // early-return branch (command === "agent.invoke") and not
        // re-trigger migration.
        strictEqual(onDisk.command, "agent.invoke");
        ok(typeof onDisk.args.prompt === "string");
        ok(onDisk.args.prompt.includes("github trending"));
        // Legacy-only `q` field is preserved verbatim so the agent's
        // intent survives the round-trip.
        strictEqual(onDisk.args.q, "github trending open source AI project today 2026");
    });
});

async function writeBad(dir: string, name: string, contents: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, name), contents, "utf8");
    ok(true);
}
