/**
 * Memory consolidation ("dream"): store archive primitives, the workspace
 * lock, plan parsing / validation, the preview → confirm → apply flow, undo,
 * and topic usage tracking.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    applyPendingDream,
    type DreamDeps,
    discardPendingDream,
    readPendingDream,
    runDream,
    summarizeOutcome,
    undoDreamReport,
} from "../../src/memory/dream/consolidator.ts";
import { MAX_WORKSPACES_PER_RUN, runDreamJob } from "../../src/memory/dream/dreamJob.ts";
import {
    buildTopicViews,
    DEFAULT_DREAM_OPTIONS,
    type DreamAction,
    parseDreamActions,
    validateDreamPlan,
} from "../../src/memory/dream/dreamPlan.ts";
import {
    HOLDER_STALE_MS,
    markDreamConfirmed,
    readLastDreamAt,
    readTopicUsage,
    releaseDreamLock,
    rollbackDreamLock,
    tryAcquireDreamLock,
} from "../../src/memory/dream/dreamState.ts";
import { createTopicUsageTracker } from "../../src/memory/dream/usageTracker.ts";
import { LocalMemoryStore } from "../../src/memory/index.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type { Api, Model, Models, TextContent } from "../../src/runtime/pi/types.ts";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let prevTacoHome: string | undefined;

beforeEach(() => {
    prevTacoHome = process.env.TACO_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), "taco-dream-"));
    process.env.TACO_HOME = tmpRoot;
});

afterEach(() => {
    if (prevTacoHome === undefined) Reflect.deleteProperty(process.env, "TACO_HOME");
    else process.env.TACO_HOME = prevTacoHome;
    rmSync(tmpRoot, { recursive: true, force: true });
});

function mkStore(): LocalMemoryStore {
    const store = new LocalMemoryStore();
    store.initialize("/ws/dream");
    return store;
}

const topic = (id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id,
    name: `Name ${id}`,
    description: `About ${id}`,
    type: "project",
    content: `content of ${id}`,
    createdAt: new Date(NOW.getTime() - DAY).toISOString(),
    ...overrides,
});

async function seed(store: LocalMemoryStore, entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) await store.appendEntry(entry);
}

/** Model double: returns `plan` as the consolidation JSON, recording each call. */
function fakeDeps(store: LocalMemoryStore, plan: unknown): DreamDeps & { calls: number } {
    const deps = {
        store,
        calls: 0,
        model: { provider: "test", id: "m" } as unknown as Model<Api>,
        models: {} as Models,
    };
    deps.models = {
        completeSimple: async () => {
            deps.calls++;
            return {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: typeof plan === "string" ? plan : JSON.stringify(plan),
                    } satisfies TextContent,
                ],
            };
        },
    } as unknown as Models;
    return deps;
}

const fixedNow = () => NOW;

// ─── store archive primitives ─────────────────────────────────────────────────

describe("LocalMemoryStore archive / restore", () => {
    it("archive moves a topic out of listTopics and injection; restore brings it back", async () => {
        const store = mkStore();
        await seed(store, [topic("keep"), topic("old")]);

        await store.archiveTopic("old");
        assert.deepEqual(
            store.listTopics().map((t) => t.id),
            ["keep"],
        );
        assert.ok(!store.buildMemoryBlock().includes("— old"));
        assert.deepEqual(
            store.listArchivedTopics().map((t) => t.id),
            ["old"],
        );
        assert.ok(existsSync(join(store.topicDir, "archive", "old.md")));

        await store.restoreTopic("old");
        assert.deepEqual(
            store
                .listTopics()
                .map((t) => t.id)
                .sort(),
            ["keep", "old"],
        );
        assert.equal(store.listArchivedTopics().length, 0);
    });

    it("archive with a stale expectedContent leaves the topic in place", async () => {
        const store = mkStore();
        await seed(store, [topic("a", { content: "v1" })]);
        await store.updateTopic("a", "v2");
        await assert.rejects(
            () => store.archiveTopic("a", { expectedContent: "v1" }),
            /changed since it was read/,
        );
        assert.equal(store.getTopic("a")?.content, "v2");
    });

    it("deleteTopic honours expectedContent", async () => {
        const store = mkStore();
        await seed(store, [topic("a", { content: "v1" })]);
        await assert.rejects(() => store.deleteTopic("a", { expectedContent: "nope" }));
        assert.ok(store.getTopic("a"));
        await store.deleteTopic("a", { expectedContent: "v1" });
        assert.equal(store.getTopic("a"), undefined);
    });

    it("restore refuses when a live topic took the id", async () => {
        const store = mkStore();
        await seed(store, [topic("a")]);
        await store.archiveTopic("a");
        await store.appendEntry(topic("a", { content: "new" }));
        await assert.rejects(() => store.restoreTopic("a"), /already exists/);
        assert.equal(store.getTopic("a")?.content, "new");
    });
});

// ─── lock ─────────────────────────────────────────────────────────────────────

describe("dream lock", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpRoot, "lock-"));
    });

    it("acquire stamps the run time; release keeps it; rollback rewinds it", () => {
        assert.equal(readLastDreamAt(dir), 0);
        const prior = tryAcquireDreamLock(dir);
        assert.equal(prior, 0);
        assert.ok(readLastDreamAt(dir) > 0);

        releaseDreamLock(dir);
        const afterRelease = readLastDreamAt(dir);
        assert.ok(afterRelease > 0);

        // utimes round-trips through filesystem precision; ms drift is irrelevant
        // for an hours-scale gate.
        const prior2 = tryAcquireDreamLock(dir);
        assert.ok(prior2 !== null && Math.abs(prior2 - afterRelease) < 5);
        rollbackDreamLock(dir, afterRelease);
        assert.ok(Math.abs(readLastDreamAt(dir) - afterRelease) < 5);
    });

    it("rollback of a first-ever run removes the lock entirely", () => {
        const prior = tryAcquireDreamLock(dir);
        assert.equal(prior, 0);
        rollbackDreamLock(dir, 0);
        assert.equal(readLastDreamAt(dir), 0);
    });

    it("a live foreign holder blocks; a stale one is reclaimed", () => {
        assert.notEqual(tryAcquireDreamLock(dir), null);
        const lock = join(dir, ".dream", "lock");
        // process.ppid is alive and is not this process.
        writeFileSync(lock, String(process.ppid));
        assert.equal(tryAcquireDreamLock(dir), null);

        const old = new Date(Date.now() - HOLDER_STALE_MS - 1000);
        utimesSync(lock, old, old);
        assert.notEqual(tryAcquireDreamLock(dir), null);
    });

    it("a dead holder is reclaimed immediately", () => {
        tryAcquireDreamLock(dir);
        writeFileSync(join(dir, ".dream", "lock"), "999999999");
        assert.notEqual(tryAcquireDreamLock(dir), null);
    });
});

// ─── plan parsing / validation ────────────────────────────────────────────────

describe("dream plan", () => {
    const views = (entries: MemoryEntry[], usage: Record<string, string> = {}) =>
        buildTopicViews(entries, usage, DEFAULT_DREAM_OPTIONS, NOW.getTime());

    it("parses the actions object, a bare array, and drops malformed items", () => {
        const plan = {
            actions: [
                {
                    action: "merge",
                    sourceIds: ["a", "b"],
                    id: "AB Merged",
                    name: "n",
                    type: "user",
                    content: "c",
                },
                { action: "rewrite", id: "c", content: "tight" },
                { action: "archive", id: "d", reason: "obsolete" },
                { action: "archive", id: "e" },
                {
                    action: "merge",
                    sourceIds: ["a"],
                    id: "x",
                    name: "n",
                    type: "nope",
                    content: "c",
                },
                { action: "delete", id: "f" },
                null,
                42,
            ],
        };
        const parsed = parseDreamActions(`Sure:\n${JSON.stringify(plan)}`);
        assert.ok(parsed);
        assert.deepEqual(
            parsed.map((a) => a.action),
            ["merge", "rewrite", "archive"],
        );
        assert.equal((parsed[0] as { id: string }).id, "ab-merged");

        const bare = parseDreamActions(
            JSON.stringify([{ action: "rewrite", id: "c", content: "x" }]),
        );
        assert.equal(bare?.length, 1);
        assert.equal(parseDreamActions("no json here"), null);
    });

    it("marks topics stale by the latest of write and read time, per type horizon", () => {
        const old = new Date(NOW.getTime() - 100 * DAY).toISOString();
        const recentRead = new Date(NOW.getTime() - 2 * DAY).toISOString();
        const v = views(
            [
                topic("p-old", { createdAt: old }),
                topic("p-read", { createdAt: old }),
                topic("u-old", { createdAt: old, type: "user" }),
            ],
            { "p-read": recentRead },
        );
        const byId = Object.fromEntries(v.map((x) => [x.id, x]));
        assert.equal(byId["p-old"]?.stale, true);
        assert.equal(byId["p-read"]?.stale, false, "a recent read keeps a topic active");
        assert.equal(byId["u-old"]?.stale, false, "user topics use the 180-day horizon");
    });

    it("rejects unknown ids, overlaps, short merges, and reused merge ids", () => {
        const v = views(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => topic(id)));
        const reject = (actions: DreamAction[], pattern: RegExp) => {
            const check = validateDreamPlan(actions, v);
            assert.equal(check.ok, false);
            if (!check.ok) assert.match(check.reason, pattern);
        };
        const merge = (sourceIds: string[], id: string): DreamAction => ({
            action: "merge",
            sourceIds,
            id,
            name: "n",
            description: "d",
            type: "project",
            content: "c",
        });
        reject([{ action: "rewrite", id: "zz", content: "x" }], /does not exist/);
        reject([merge(["a", "zz"], "m")], /does not exist/);
        reject([merge(["a"], "m")], /at least two/);
        reject([merge(["a", "b"], "c")], /reuses an existing id/);
        reject([merge(["a", "b"], "m"), merge(["c", "d"], "m")], /two merges target/);
        reject(
            [
                { action: "rewrite", id: "a", content: "x" },
                { action: "archive", id: "a", reason: "r", supersededBy: "b" },
            ],
            /two actions/,
        );
    });

    it("an active topic may only be archived when a surviving topic holds its fact", () => {
        const v = views(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => topic(id)));
        const noSurvivor = validateDreamPlan([{ action: "archive", id: "a", reason: "dup" }], v);
        assert.equal(noSurvivor.ok, false);

        const toKept = validateDreamPlan(
            [{ action: "archive", id: "a", reason: "dup", supersededBy: "b" }],
            v,
        );
        assert.equal(toKept.ok, true);

        const toRetired = validateDreamPlan(
            [
                { action: "archive", id: "a", reason: "dup", supersededBy: "b" },
                { action: "archive", id: "b", reason: "dup", supersededBy: "c" },
            ],
            v,
        );
        assert.equal(toRetired.ok, false, "pointing at a topic the same plan retires");

        const toMerge = validateDreamPlan(
            [
                {
                    action: "merge",
                    sourceIds: ["b", "c"],
                    id: "bc",
                    name: "n",
                    description: "d",
                    type: "project",
                    content: "c",
                },
                { action: "archive", id: "a", reason: "covered", supersededBy: "bc" },
            ],
            v,
        );
        assert.equal(toMerge.ok, true, "a merge target counts as a survivor");
    });

    it("caps retirement at 30% of topics, merge sources included", () => {
        const old = new Date(NOW.getTime() - 200 * DAY).toISOString();
        const v = views(
            ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) =>
                topic(id, { createdAt: old }),
            ),
        );
        const archives = (ids: string[]): DreamAction[] =>
            ids.map((id) => ({ action: "archive", id, reason: "stale" }));
        assert.equal(validateDreamPlan(archives(["a", "b", "c"]), v).ok, true);
        const over = validateDreamPlan(archives(["a", "b", "c", "d"]), v);
        assert.equal(over.ok, false);
        if (!over.ok) assert.match(over.reason, /cap 3/);
    });
});

// ─── run flow ─────────────────────────────────────────────────────────────────

const ten = () => ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => topic(id));

const mergePlan = {
    actions: [
        {
            action: "merge",
            sourceIds: ["a", "b"],
            id: "ab",
            name: "AB",
            description: "merged",
            type: "project",
            content: "a and b",
        },
        { action: "rewrite", id: "c", content: "c, tightened" },
    ],
};

describe("runDream", () => {
    it("first run only previews; nothing on disk changes", async () => {
        const store = mkStore();
        await seed(store, ten());
        const deps = fakeDeps(store, mergePlan);

        const outcome = await runDream(deps, { now: fixedNow });
        assert.equal(outcome.status, "previewed");
        assert.equal(store.listTopics().length, 10);
        assert.equal(store.getTopic("c")?.content, "content of c");
        assert.ok(readPendingDream(store));
        assert.match(summarizeOutcome(outcome), /preview ready: merged 2→1, archived 0, rewrote 1/);
    });

    it("a pending preview blocks further scheduled runs; discard clears it", async () => {
        const store = mkStore();
        await seed(store, ten());
        const deps = fakeDeps(store, mergePlan);
        await runDream(deps, { now: fixedNow });

        const again = await runDream(deps, { now: () => new Date(NOW.getTime() + 2 * DAY) });
        assert.equal(again.status, "skipped");
        assert.equal(deps.calls, 1);

        discardPendingDream(store);
        assert.equal(readPendingDream(store), undefined);
    });

    it("applying the preview confirms the workspace; later runs apply directly", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { now: fixedNow });

        const report = await applyPendingDream(store, fixedNow);
        assert.deepEqual(report.created, ["ab"]);
        assert.deepEqual([...report.archived].sort(), ["a", "b"]);
        assert.equal(store.getTopic("ab")?.content, "a and b");
        assert.equal(store.getTopic("c")?.content, "c, tightened");
        assert.equal(store.getTopic("a"), undefined);
        assert.equal(readPendingDream(store), undefined);

        const forced = await runDream(
            fakeDeps(store, { actions: [{ action: "rewrite", id: "d", content: "d2" }] }),
            { force: true, now: fixedNow },
        );
        assert.equal(forced.status, "applied");
        assert.equal(store.getTopic("d")?.content, "d2");
    });

    it("previewOnly stores a plan even for a confirmed workspace", async () => {
        const store = mkStore();
        await seed(store, ten());
        markDreamConfirmed(store.topicDir);
        const outcome = await runDream(fakeDeps(store, mergePlan), {
            force: true,
            previewOnly: true,
            now: fixedNow,
        });
        assert.equal(outcome.status, "previewed");
        assert.equal(store.getTopic("a")?.content, "content of a");
    });

    it("skips a topic edited between planning and apply, keeping the edit", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { now: fixedNow });
        await store.updateTopic("c", "user edit");
        await store.updateTopic("a", "user edit of a");

        const report = await applyPendingDream(store, fixedNow);
        assert.equal(store.getTopic("c")?.content, "user edit");
        assert.equal(store.getTopic("a")?.content, "user edit of a", "merge rolled back whole");
        assert.ok(store.getTopic("b"), "the other merge source was restored");
        assert.equal(store.getTopic("ab"), undefined);
        assert.deepEqual([...report.skipped].sort(), ["ab", "c"]);
    });

    it("an invalid plan fails and rewinds the lock so the next run retries", async () => {
        const store = mkStore();
        await seed(store, ten());
        const outcome = await runDream(
            fakeDeps(store, { actions: [{ action: "rewrite", id: "missing", content: "x" }] }),
            { now: fixedNow },
        );
        assert.equal(outcome.status, "failed");
        assert.equal(readLastDreamAt(store.topicDir), 0);
        assert.equal(readPendingDream(store), undefined);
    });

    it("unparseable model output fails without touching memory", async () => {
        const store = mkStore();
        await seed(store, ten());
        const outcome = await runDream(fakeDeps(store, "I cannot help with that."), {
            now: fixedNow,
        });
        assert.equal(outcome.status, "failed");
        assert.equal(store.listTopics().length, 10);
    });

    it("an empty plan succeeds as a no-op and stamps the run time", async () => {
        const store = mkStore();
        await seed(store, ten());
        const outcome = await runDream(fakeDeps(store, { actions: [] }), { now: fixedNow });
        assert.equal(outcome.status, "skipped");
        assert.ok(readLastDreamAt(store.topicDir) > 0);
    });

    it("scheduled runs wait for both the time gate and enough churn", async () => {
        // The gate reads real file mtimes, so this test runs on the real clock.
        const store = mkStore();
        const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
        await seed(
            store,
            ten().map((t) => ({ ...t, createdAt: monthAgo })),
        );
        markDreamConfirmed(store.topicDir);
        // Pretend the last run was 2h ago.
        tryAcquireDreamLock(store.topicDir);
        releaseDreamLock(store.topicDir);
        const lock = join(store.topicDir, ".dream", "lock");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(lock, twoHoursAgo, twoHoursAgo);

        const deps = fakeDeps(store, { actions: [] });
        const tooSoon = await runDream(deps, {});
        assert.equal(tooSoon.status, "skipped");
        if (tooSoon.status === "skipped") assert.match(tooSoon.reason, /last run/);

        const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(lock, dayAgo, dayAgo);
        const quiet = await runDream(deps, {});
        assert.equal(quiet.status, "skipped", "seeded topics predate the last run");
        if (quiet.status === "skipped") assert.match(quiet.reason, /changed since/);
        assert.equal(deps.calls, 0);

        for (const id of ["n1", "n2", "n3", "n4", "n5"]) {
            await store.appendEntry(topic(id, { createdAt: new Date().toISOString() }));
        }
        const busy = await runDream(deps, {});
        assert.equal(deps.calls, 1, `expected a model call, got ${JSON.stringify(busy)}`);
    });

    it("too few topics is never worth a model call, even when forced", async () => {
        const store = mkStore();
        await seed(store, [topic("a"), topic("b")]);
        const deps = fakeDeps(store, mergePlan);
        const outcome = await runDream(deps, { force: true, now: fixedNow });
        assert.equal(outcome.status, "skipped");
        assert.equal(deps.calls, 0);
    });

    it("a held lock makes a concurrent run skip", async () => {
        const store = mkStore();
        await seed(store, ten());
        tryAcquireDreamLock(store.topicDir);
        writeFileSync(join(store.topicDir, ".dream", "lock"), String(process.ppid));
        const outcome = await runDream(fakeDeps(store, mergePlan), { force: true, now: fixedNow });
        assert.equal(outcome.status, "skipped");
        if (outcome.status === "skipped") assert.match(outcome.reason, /lock/);
    });
});

// ─── undo ─────────────────────────────────────────────────────────────────────

describe("undoDreamReport", () => {
    it("reverts merges and rewrites, and refuses a second undo", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { now: fixedNow });
        const report = await applyPendingDream(store, fixedNow);

        const conflicts = await undoDreamReport(store, report.id);
        assert.deepEqual(conflicts, []);
        assert.equal(store.getTopic("a")?.content, "content of a");
        assert.equal(store.getTopic("b")?.content, "content of b");
        assert.equal(store.getTopic("c")?.content, "content of c");
        assert.equal(store.getTopic("ab"), undefined);
        assert.ok(
            store.listArchivedTopics().some((t) => t.id === "ab"),
            "the merged topic stays recoverable",
        );
        await assert.rejects(() => undoDreamReport(store, report.id), /already undone/);
    });

    it("reports topics changed after the run instead of overwriting them", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { now: fixedNow });
        const report = await applyPendingDream(store, fixedNow);
        await store.appendEntry(topic("a", { content: "a recreated" }));

        const conflicts = await undoDreamReport(store, report.id);
        assert.deepEqual(conflicts, ["a"]);
        assert.equal(store.getTopic("a")?.content, "a recreated");
    });

    it("keeps a rewrite or merge the user edited after the run", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { now: fixedNow });
        const report = await applyPendingDream(store, fixedNow);
        await store.updateTopic("c", "user edit of the rewrite");
        await store.updateTopic("ab", "user edit of the merge");

        const conflicts = await undoDreamReport(store, report.id);
        assert.deepEqual([...conflicts].sort(), ["ab", "c"]);
        assert.equal(store.getTopic("c")?.content, "user edit of the rewrite");
        assert.equal(store.getTopic("ab")?.content, "user edit of the merge");
        // The merge sources still come back: restoring them loses nothing.
        assert.equal(store.getTopic("a")?.content, "content of a");
    });

    it("rejects an unknown or path-like report id", async () => {
        const store = mkStore();
        await assert.rejects(() => undoDreamReport(store, "nope"), /unknown/);
        await assert.rejects(() => undoDreamReport(store, "../../etc"), /unknown/);
    });
});

// ─── usage tracking ───────────────────────────────────────────────────────────

describe("topic usage tracker", () => {
    it("records reads of top-level topic files only, keeping the latest time", () => {
        const store = mkStore();
        const dir = store.topicDir;
        let clock = NOW;
        const tracker = createTopicUsageTracker({
            topicDir: dir,
            cwd: "/elsewhere",
            now: () => clock,
        });

        tracker.noteRead(join(dir, "alpha.md"));
        tracker.noteRead(join(dir, "archive", "old.md"));
        tracker.noteRead(join(dir, ".dream", "usage.md"));
        tracker.noteRead("/somewhere/else/beta.md");
        tracker.noteRead(join(dir, "notes.txt"));
        tracker.noteRead(42);
        tracker.flush();
        assert.deepEqual(readTopicUsage(dir), { alpha: NOW.toISOString() });

        clock = new Date(NOW.getTime() + DAY);
        tracker.noteRead(join(dir, "alpha.md"));
        tracker.flush();
        assert.equal(readTopicUsage(dir).alpha, clock.toISOString());
    });

    it("resolves relative paths against the session cwd", () => {
        const store = mkStore();
        const dir = store.topicDir;
        const tracker = createTopicUsageTracker({ topicDir: dir, cwd: dir, now: fixedNow });
        tracker.noteRead("./gamma.md");
        tracker.flush();
        assert.equal(readTopicUsage(dir).gamma, NOW.toISOString());
    });

    it("tracking never touches the topic file itself", async () => {
        const store = mkStore();
        await seed(store, [topic("alpha")]);
        const file = join(store.topicDir, "alpha.md");
        const before = statSync(file).mtimeMs;
        const tracker = createTopicUsageTracker({
            topicDir: store.topicDir,
            cwd: "/",
            now: fixedNow,
        });
        tracker.noteRead(file);
        tracker.flush();
        assert.equal(statSync(file).mtimeMs, before);
        assert.equal(store.getTopic("alpha")?.updatedAt, undefined);
    });
});

// ─── process-level job ────────────────────────────────────────────────────────

describe("runDreamJob", () => {
    function storeFor(name: string): LocalMemoryStore {
        const store = new LocalMemoryStore();
        store.initialize(`/ws/${name}`);
        return store;
    }

    function modelReturning(plan: unknown) {
        let calls = 0;
        const models = {
            completeSimple: async () => {
                calls++;
                return {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: typeof plan === "string" ? plan : JSON.stringify(plan),
                        } satisfies TextContent,
                    ],
                };
            },
        } as unknown as Models;
        return {
            calls: () => calls,
            resolve: () => ({ models, model: { provider: "t", id: "m" } as unknown as Model<Api> }),
        };
    }

    it("is a no-op when memory is disabled, without resolving a model", async () => {
        let resolved = false;
        const result = await runDreamJob({
            memoryEnabled: () => false,
            resolveModel: () => {
                resolved = true;
                return undefined;
            },
        });
        assert.match(result.summary, /memory is disabled/);
        assert.equal(resolved, false);
    });

    it("fails visibly when no model resolves", async () => {
        await assert.rejects(
            () => runDreamJob({ memoryEnabled: () => true, resolveModel: () => undefined }),
            /no model available/,
        );
    });

    it("walks project dirs, previews unconfirmed ones, and summarizes", async () => {
        const a = storeFor("a");
        const b = storeFor("b");
        await seed(a, ten());
        await seed(b, [topic("only")]);
        const model = modelReturning(mergePlan);

        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: model.resolve,
        });
        assert.equal(model.calls(), 1, "b has too few topics for a model call");
        assert.equal(result.summary, "1 preview awaiting review");
        const byKey = Object.fromEntries(result.outcomes.map((o) => [o.dirKey, o.outcome.status]));
        assert.equal(byKey[a.dirKey], "previewed");
        assert.equal(byKey[b.dirKey], "skipped");
    });

    it("applies directly for confirmed workspaces", async () => {
        const a = storeFor("a");
        await seed(a, ten());
        markDreamConfirmed(a.topicDir);
        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: modelReturning(mergePlan).resolve,
        });
        assert.match(result.summary, /^1 consolidated \(merged 2→1, archived 0, rewrote 1\)$/);
        assert.equal(a.getTopic("ab")?.content, "a and b");
    });

    it("caps model calls per fire and serves the least recently consolidated first", async () => {
        const stores = Array.from({ length: MAX_WORKSPACES_PER_RUN + 2 }, (_, i) =>
            storeFor(`w${i}`),
        );
        for (const store of stores) await seed(store, ten());
        // w0 consolidated recently: it must queue behind never-consolidated dirs.
        tryAcquireDreamLock(stores[0]?.topicDir ?? "");
        releaseDreamLock(stores[0]?.topicDir ?? "");
        const model = modelReturning(mergePlan);

        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: model.resolve,
            listDirKeys: () => stores.map((s) => s.dirKey),
        });
        assert.equal(model.calls(), MAX_WORKSPACES_PER_RUN);
        const reached = new Set(result.outcomes.map((o) => o.dirKey));
        assert.ok(
            !reached.has(stores[0]?.dirKey ?? ""),
            "the freshest dir waits for the next fire",
        );
    });

    it("throws when every model call fails, so the failure breaker can trip", async () => {
        const a = storeFor("a");
        await seed(a, ten());
        await assert.rejects(
            () =>
                runDreamJob({
                    memoryEnabled: () => true,
                    resolveModel: modelReturning("not json").resolve,
                }),
            /1 failed: the model returned no parseable plan/,
        );
    });

    it("reports a quiet night when nothing passes its gate", async () => {
        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: modelReturning(mergePlan).resolve,
            listDirKeys: () => [],
        });
        assert.equal(result.summary, "no workspace needed consolidation");
    });
});
