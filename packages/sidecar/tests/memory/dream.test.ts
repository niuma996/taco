/**
 * Memory consolidation ("dream"): store archive primitives, the workspace
 * lock, plan parsing / validation, the preview → confirm → apply flow, undo,
 * and topic usage tracking.
 */

import { strict as assert } from "node:assert";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import {
    applyPendingDream,
    DREAM_PROMPT_BUDGET_CHARS,
    type DreamDeps,
    discardPendingDream,
    dreamGateReason,
    readPendingDream,
    runDream,
    selectTopicsForPrompt,
    summarizeOutcome,
    undoDreamReport,
} from "../../src/memory/dream/consolidator.ts";
import {
    MAX_WORKSPACES_PER_RUN,
    NO_MODEL_SUMMARY,
    runDreamJob,
} from "../../src/memory/dream/dreamJob.ts";
import {
    buildTopicViews,
    capRetirement,
    DEFAULT_DREAM_OPTIONS,
    type DreamAction,
    resolveActionIds,
    trimConflictingActions,
    validateDreamPlan,
} from "../../src/memory/dream/dreamPlan.ts";
import {
    dreamRetryAt,
    HOLDER_STALE_MS,
    isDreamLocked,
    KEPT_DREAM_REPORTS,
    listDreamReportIds,
    markDreamConfirmed,
    readDreamReport,
    readDreamSelectionRound,
    readLastDreamAt,
    readTopicUsage,
    recordDreamFailure,
    recordTopicUsage,
    releaseDreamLock,
    rollbackDreamLock,
    tryAcquireDreamLock,
    writeDreamReport,
} from "../../src/memory/dream/dreamState.ts";
import { dreamResultTool } from "../../src/memory/dream/dreamTool.ts";
import { createTopicUsageTracker } from "../../src/memory/dream/usageTracker.ts";
import { LocalMemoryStore } from "../../src/memory/index.ts";
import { readMemorySubmission } from "../../src/memory/submission.ts";
import type { MemoryEntry } from "../../src/memory/types.ts";
import type { Api, AssistantMessage, Model, Models } from "../../src/runtime/pi/types.ts";

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
    return mkStoreAt("/ws/dream");
}

function mkStoreAt(workspace: string): LocalMemoryStore {
    const store = new LocalMemoryStore();
    store.initialize(workspace);
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

function dreamResponse(plan: unknown): AssistantMessage {
    return {
        role: "assistant",
        stopReason: "toolUse",
        content:
            typeof plan === "string"
                ? [{ type: "text", text: plan }]
                : [{ type: "toolCall", id: "plan", name: dreamResultTool.name, arguments: plan }],
    } as AssistantMessage;
}

function submit(actions: unknown[]) {
    return readMemorySubmission(dreamResponse({ actions }), dreamResultTool).actions;
}

function fakeDeps(store: LocalMemoryStore, plan: unknown) {
    const deps = {
        store,
        calls: 0,
        model: { provider: "test", id: "m" } as unknown as Model<Api>,
        models: {} as Models,
    };
    deps.models = {
        completeSimple: async () => {
            deps.calls++;
            return dreamResponse(plan);
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

    it("archiving the same id twice replaces the archived copy", async () => {
        const store = mkStore();
        await seed(store, [topic("a", { content: "v1" })]);
        await store.archiveTopic("a");
        await store.appendEntry(topic("a", { content: "v2" }));
        await store.archiveTopic("a");
        await store.restoreTopic("a");
        assert.equal(store.getTopic("a")?.content, "v2");
    });

    it("restore rejects path-like ids instead of moving files outside archive", async () => {
        const store = mkStore();
        const outside = join(store.topicDir, "outside.md");
        writeFileSync(outside, "do not move");
        await assert.rejects(() => store.restoreTopic("../outside"), /invalid memory topic id/);
        assert.equal(readFileSync(outside, "utf8"), "do not move");
        await assert.rejects(() => store.restoreTopic("..\\outside"), /invalid memory topic id/);
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

    it("only a successful release stamps the run time; rollback leaves it", () => {
        assert.equal(readLastDreamAt(dir), 0);
        assert.equal(tryAcquireDreamLock(dir), true);
        // Held, not yet stamped: the run's own writes must fall before the stamp.
        assert.equal(readLastDreamAt(dir), 0);
        assert.equal(isDreamLocked(dir), true);

        releaseDreamLock(dir);
        const afterRelease = readLastDreamAt(dir);
        assert.ok(afterRelease > 0);
        assert.equal(isDreamLocked(dir), false);
        assert.equal(existsSync(join(dir, ".dream", "lock")), false, "the holder file is gone");

        assert.equal(tryAcquireDreamLock(dir), true);
        rollbackDreamLock(dir);
        assert.equal(readLastDreamAt(dir), afterRelease, "a failed run keeps the last stamp");
    });

    it("reads a released legacy lock's mtime as the last run, then moves to last-run", () => {
        mkdirSync(join(dir, ".dream"), { recursive: true });
        const lock = join(dir, ".dream", "lock");
        // What the previous version left behind: an empty, released lock.
        writeFileSync(lock, "");
        const dayAgo = new Date(Date.now() - DAY);
        utimesSync(lock, dayAgo, dayAgo);
        assert.ok(Math.abs(readLastDreamAt(dir) - dayAgo.getTime()) < 5);

        // The legacy file does not block a new run, and success writes last-run.
        assert.equal(tryAcquireDreamLock(dir), true);
        releaseDreamLock(dir);
        assert.ok(readLastDreamAt(dir) > dayAgo.getTime() + 1000);
        assert.equal(existsSync(lock), false);
    });

    it("a first-ever run that fails leaves no run time", () => {
        assert.equal(tryAcquireDreamLock(dir), true);
        rollbackDreamLock(dir);
        assert.equal(readLastDreamAt(dir), 0);
        assert.equal(isDreamLocked(dir), false);
    });

    it("a live foreign holder blocks; a stale one is reclaimed", () => {
        mkdirSync(join(dir, ".dream"), { recursive: true });
        const lock = join(dir, ".dream", "lock");
        // process.ppid is alive and is not this process.
        writeFileSync(lock, String(process.ppid));
        assert.equal(tryAcquireDreamLock(dir), false);

        const old = new Date(Date.now() - HOLDER_STALE_MS - 1000);
        utimesSync(lock, old, old);
        assert.equal(tryAcquireDreamLock(dir), true);
        assert.equal(readFileSync(lock, "utf8"), String(process.pid));
    });

    it("a dead holder is reclaimed immediately", () => {
        mkdirSync(join(dir, ".dream"), { recursive: true });
        writeFileSync(join(dir, ".dream", "lock"), "999999999");
        assert.equal(tryAcquireDreamLock(dir), true);
    });

    it("a second acquire in the same process cannot steal the lock", () => {
        assert.equal(tryAcquireDreamLock(dir), true);
        assert.equal(tryAcquireDreamLock(dir), false);
        releaseDreamLock(dir);
        assert.equal(tryAcquireDreamLock(dir), true);
    });

    it("a release never removes a lock another holder reclaimed", () => {
        assert.equal(tryAcquireDreamLock(dir), true);
        const lock = join(dir, ".dream", "lock");
        // Another process judged ours stale and took over.
        writeFileSync(lock, String(process.ppid));
        rollbackDreamLock(dir);
        assert.equal(readFileSync(lock, "utf8"), String(process.ppid), "the new holder keeps it");
    });
});

// ─── plan parsing / validation ────────────────────────────────────────────────

describe("dream plan", () => {
    const views = (entries: MemoryEntry[], usage: Record<string, string> = {}) =>
        buildTopicViews(entries, usage, DEFAULT_DREAM_OPTIONS, NOW.getTime());

    it("accepts only the declared action envelope and known fields", () => {
        assert.deepEqual(submit([]), []);
        assert.throws(() => readMemorySubmission(dreamResponse({ merges: [] }), dreamResultTool));
        assert.throws(() => submit([{ kind: "rewrite", id: "a", content: "fact" }]));
        assert.throws(() => submit([{ action: "rewrite", id: "a", content: "fact", sources: [] }]));
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

    it("accepts structured archive categories and evidence", () => {
        const action = {
            action: "archive",
            id: "a",
            reason: "obsolete",
            category: "invalidated",
            evidence: "The old fact is obsolete.",
        };
        assert.deepEqual(submit([action]), [action]);
        assert.throws(() => submit([{ ...action, category: "invented" }]));
    });

    it("requires survivors and concrete evidence for archive categories", () => {
        const old = new Date(NOW.getTime() - 200 * DAY).toISOString();
        const entries = [
            topic("a", { createdAt: old, content: "The old fact is obsolete." }),
            topic("b", { content: "The corrected fact." }),
            topic("c", { createdAt: old, content: "temporary note" }),
        ];
        const v = views(entries);
        const check = (action: DreamAction) => validateDreamPlan([action], v);
        assert.equal(
            check({ action: "archive", id: "a", reason: "duplicate", category: "duplicate" }).ok,
            false,
        );
        assert.equal(
            check({
                action: "archive",
                id: "a",
                reason: "duplicate",
                category: "duplicate",
                supersededBy: "b",
            }).ok,
            true,
        );
        assert.equal(
            check({ action: "archive", id: "a", reason: "wrong", category: "invalidated" }).ok,
            false,
        );
        assert.equal(
            check({
                action: "archive",
                id: "a",
                reason: "wrong",
                category: "invalidated",
                evidence: "invented quote",
            }).ok,
            false,
        );
        assert.equal(
            check({
                action: "archive",
                id: "a",
                reason: "wrong",
                category: "invalidated",
                evidence: "The old fact is obsolete.",
            }).ok,
            true,
        );
    });

    it("requires known automatic origin and protects explicit low-usefulness topics", () => {
        const v = views([
            topic("fresh", {
                content: "automatic note",
                sources: [{ sessionId: "s", recordedAt: NOW.toISOString(), via: "auto" }],
            }),
            topic("explicit", {
                createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
                explicitlyRequested: true,
            }),
        ]);
        const fresh = validateDreamPlan(
            [{ action: "archive", id: "fresh", reason: "temporary", category: "transient" }],
            v,
        );
        assert.equal(
            fresh.ok,
            true,
            "fresh automatic memory may be retired when its origin is known",
        );
        const unknown = validateDreamPlan(
            [{ action: "archive", id: "fresh", reason: "temporary", category: "transient" }],
            views([topic("fresh", { content: "automatic note" })]),
        );
        assert.equal(unknown.ok, false, "unknown origin is conservative");
        const explicit = validateDreamPlan(
            [{ action: "archive", id: "explicit", reason: "unused", category: "stale" }],
            v,
        );
        assert.equal(explicit.ok, false);
    });

    it("runs archive cleanup before model availability and topic gates", async () => {
        const store = mkStore();
        await seed(store, [topic("a"), topic("b")]);
        let calls = 0;
        const result = await runDreamJob(
            {
                memoryEnabled: () => true,
                resolveModel: () => undefined,
                listDirKeys: () => [store.dirKey],
            },
            {
                options: { archiveCleanupEnabled: true, archiveRetentionDays: 7 },
            },
        );
        calls++;
        assert.equal(calls, 1);
        assert.match(result.summary, /cleanup|no model|needed/i);
    });

    it("trims an over-reaching plan down to the cap instead of rejecting it", () => {
        const old = new Date(NOW.getTime() - 200 * DAY).toISOString();
        const v = views(
            ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) =>
                topic(id, { createdAt: old }),
            ),
        );
        const archives = (ids: string[]): DreamAction[] =>
            ids.map((id) => ({ action: "archive", id, reason: "stale" }));
        const capped = capRetirement(archives(["a", "b", "c", "d", "e"]), v);
        assert.equal(capped.dropped, 2);
        assert.deepEqual(
            capped.actions.map((a) => (a.action === "archive" ? a.id : "")),
            // The tail goes first: later entries are the model's lowest guesses.
            ["a", "b", "c"],
        );
        assert.equal(validateDreamPlan(capped.actions, v).ok, true);

        assert.equal(capRetirement(archives(["a", "b"]), v).dropped, 0);
    });

    it("drops merges only when archives alone cannot make room", () => {
        const old = new Date(NOW.getTime() - 200 * DAY).toISOString();
        const v = views(
            ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) =>
                topic(id, { createdAt: old }),
            ),
        );
        const merge = (sourceIds: string[], id: string): DreamAction => ({
            action: "merge",
            sourceIds,
            id,
            name: "n",
            description: "d",
            type: "project",
            content: "c",
        });
        const capped = capRetirement([merge(["a", "b"], "ab"), merge(["c", "d"], "cd")], v);
        assert.equal(capped.dropped, 1);
        assert.equal(capped.actions.length, 1);
        assert.equal(validateDreamPlan(capped.actions, v).ok, true);
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

    it("a small set can still merge once, but not retire past the cap", () => {
        const old = new Date(NOW.getTime() - 200 * DAY).toISOString();
        const merge = (sourceIds: string[], id: string): DreamAction => ({
            action: "merge",
            sourceIds,
            id,
            name: "n",
            description: "d",
            type: "project",
            content: "c",
        });
        // floor(3 * 0.3) is 0 — without a floor this merge would be rejected.
        const v3 = views(["a", "b", "c"].map((id) => topic(id, { createdAt: old })));
        assert.equal(validateDreamPlan([merge(["a", "b"], "ab")], v3).ok, true);

        const v4 = views(["a", "b", "c", "d"].map((id) => topic(id, { createdAt: old })));
        const twoMerges = validateDreamPlan([merge(["a", "b"], "ab"), merge(["c", "d"], "cd")], v4);
        assert.equal(twoMerges.ok, false);
        if (!twoMerges.ok) assert.match(twoMerges.reason, /cap 2/);
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
    it("mounts a result tool and accepts a plan without response text", async () => {
        const store = mkStore();
        await seed(store, ten());
        let context: { tools?: Array<{ name: string }>; systemPrompt?: string } = {};
        const deps = fakeDeps(store, mergePlan);
        deps.models = {
            completeSimple: async (_model: unknown, input: typeof context) => {
                context = input;
                return {
                    role: "assistant",
                    stopReason: "toolUse",
                    content: [
                        {
                            type: "toolCall",
                            id: "result",
                            name: "submit_memory_dream_plan",
                            arguments: mergePlan,
                        },
                    ],
                };
            },
        } as unknown as Models;
        const result = await runDream(deps, { force: true, now: fixedNow });
        assert.equal(result.status, "previewed");
        assert.deepEqual(
            context.tools?.map((tool) => tool.name),
            ["submit_memory_dream_plan"],
        );
        assert.match(context.systemPrompt ?? "", /submit_memory_dream_plan/);
        assert.equal(store.getTopic("a")?.content, "content of a");
    });

    it("rejects text-only JSON and incomplete tool results without stamping success", async () => {
        for (const stopReason of ["stop", "length", "error", "aborted"]) {
            const store = mkStoreAt(`/ws/submission-${stopReason}`);
            await seed(store, ten());
            const deps = fakeDeps(store, mergePlan);
            deps.models = {
                completeSimple: async () => ({
                    role: "assistant",
                    stopReason,
                    content:
                        stopReason === "stop"
                            ? [{ type: "text", text: JSON.stringify(mergePlan) }]
                            : [
                                  {
                                      type: "toolCall",
                                      id: "result",
                                      name: "submit_memory_dream_plan",
                                      arguments: mergePlan,
                                  },
                              ],
                }),
            } as unknown as Models;
            const result = await runDream(deps, { force: true, now: fixedNow });
            assert.equal(result.status, "failed", stopReason);
            assert.equal(readPendingDream(store), undefined);
            assert.equal(readLastDreamAt(store.topicDir), 0);
            assert.equal(isDreamLocked(store.topicDir), false);
            assert.equal(store.listTopics().length, 10);
        }
    });

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

    it("previews a trimmed plan instead of failing on the cap", async () => {
        const store = mkStore();
        const old = new Date(NOW.getTime() - 200 * DAY).toISOString();
        await seed(
            store,
            ten().map((t) => ({ ...t, createdAt: old })),
        );
        const plan = {
            actions: ["a", "b", "c", "d", "e"].map((id) => ({
                action: "archive",
                id,
                reason: "stale",
            })),
        };
        const outcome = await runDream(fakeDeps(store, plan), { now: fixedNow });
        assert.equal(outcome.status, "previewed");
        assert.match(summarizeOutcome(outcome), /archived 3/);
        assert.equal(readPendingDream(store)?.actions.length, 3);
    });

    it("rejects a truncated reply without salvaging complete actions", async () => {
        const store = mkStore();
        await seed(store, ten());
        const truncated =
            '{"actions":[{"action":"rewrite","id":"c","content":"tightened"},{"action":"rewrite"';
        const outcome = await runDream(fakeDeps(store, truncated), { now: fixedNow });
        assert.equal(outcome.status, "failed");
        assert.equal(readPendingDream(store), undefined);
        assert.equal(readLastDreamAt(store.topicDir), 0);
        assert.equal(store.getTopic("c")?.content, "content of c");
    });

    it("a reply that never names the actions array is not salvaged", async () => {
        const store = mkStore();
        await seed(store, ten());
        // Prose with brackets and a stray object: nothing points at a plan, so
        // there is nothing to recover and the run fails rather than guessing.
        const prose = 'I could not decide [maybe merge the two] {"action":"rewrite","id":"c"}';
        const outcome = await runDream(fakeDeps(store, prose), { now: fixedNow });
        assert.equal(outcome.status, "failed");
        assert.equal(readPendingDream(store), undefined);
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

    it("a structurally invalid action fails instead of no-op", async () => {
        const store = mkStore();
        await seed(store, ten());
        const outcome = await runDream(
            fakeDeps(store, { actions: [{ action: "delete", id: "a" }] }),
            { now: fixedNow },
        );
        assert.equal(outcome.status, "failed");
        if (outcome.status === "failed") assert.match(outcome.reason, /invalid .* arguments/);
        assert.equal(readLastDreamAt(store.topicDir), 0, "the time gate reopens for a retry");
    });

    it("thinking-only output at the token ceiling fails instead of an empty plan", async () => {
        const store = mkStore();
        await seed(store, ten());
        // A thinking model that spends the whole budget on reasoning answers
        // with thinking blocks and no text.
        const models = {
            completeSimple: async () => ({
                role: "assistant",
                content: [{ type: "thinking", thinking: "considering…" }],
                stopReason: "length",
            }),
        } as unknown as Models;
        const outcome = await runDream(
            { store, models, model: { provider: "t", id: "m" } as unknown as Model<Api> },
            { now: fixedNow },
        );
        assert.equal(outcome.status, "failed");
        if (outcome.status === "failed") {
            assert.match(outcome.reason, /incomplete .* length/);
        }
        assert.equal(store.listTopics().length, 10);
    });

    it("asks for minimal thinking but leaves the output ceiling to the model", async () => {
        const store = mkStore();
        await seed(store, ten());
        let seen: { reasoning?: unknown; maxTokens?: unknown } | undefined;
        const models = {
            completeSimple: async (
                _model: Model<Api>,
                _context: unknown,
                options: { reasoning?: unknown; maxTokens?: unknown },
            ) => {
                seen = options;
                return dreamResponse({ actions: [] });
            },
        } as unknown as Models;
        await runDream(
            {
                store,
                models,
                // A small explicit cap would be spent entirely on thinking by a
                // provider that ignores the thinking budget (MiniMax adaptive).
                model: { provider: "t", id: "m", reasoning: true } as unknown as Model<Api>,
            },
            { now: fixedNow },
        );
        assert.equal(seen?.reasoning, "minimal");
        assert.equal(seen?.maxTokens, undefined);
    });

    it("an empty plan succeeds as a no-op and stamps the run time", async () => {
        const store = mkStore();
        await seed(store, ten());
        const outcome = await runDream(fakeDeps(store, { actions: [] }), { now: fixedNow });
        assert.equal(outcome.status, "skipped");
        assert.ok(readLastDreamAt(store.topicDir) > 0);
    });

    it("scheduled runs wait for the time gate, then evaluate unchanged topics", async () => {
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
        const lock = join(store.topicDir, ".dream", "last-run");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(lock, twoHoursAgo, twoHoursAgo);

        const deps = fakeDeps(store, { actions: [] });
        const tooSoon = await runDream(deps, {});
        assert.equal(tooSoon.status, "skipped");
        if (tooSoon.status === "skipped") assert.match(tooSoon.reason, /last run/);

        const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(lock, dayAgo, dayAgo);
        const quiet = await runDream(deps, {});
        assert.equal(quiet.status, "skipped", "the model returned an empty plan");
        if (quiet.status === "skipped") assert.match(quiet.reason, /needs no changes/);
        assert.equal(deps.calls, 1);

        for (const id of ["n1", "n2", "n3", "n4", "n5"]) {
            await store.appendEntry(topic(id, { createdAt: new Date().toISOString() }));
        }
        utimesSync(lock, dayAgo, dayAgo);
        const busy = await runDream(deps, {});
        assert.equal(deps.calls, 2, `expected a model call, got ${JSON.stringify(busy)}`);
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

// ─── id resolution ───────────────────────────────────────────────────────────

describe("dream plan id resolution", () => {
    it("preserves exact legacy references and resolves uniquely normalized ids", () => {
        const entries = [
            topic("user_role_zh", { type: "user" }),
            topic("user_role_en", { type: "user" }),
            topic("keep_me"),
        ];
        const views = buildTopicViews(entries, {}, DEFAULT_DREAM_OPTIONS, NOW.getTime());
        const actions = submit([
            { action: "rewrite", id: "user_role_zh", content: "tightened" },
            {
                action: "archive",
                id: "userroleen",
                reason: "duplicate",
                supersededBy: "user_role_zh",
            },
        ]);
        const resolved = resolveActionIds(actions, views);
        assert.deepEqual(
            resolved.map((action) => action.id),
            ["user_role_zh", "user_role_en"],
        );
        assert.equal(validateDreamPlan(resolved, views).ok, true);
    });

    it("never remaps a new merge target to an existing legacy topic", () => {
        const views = buildTopicViews(
            [topic("user_role_zh"), topic("user_role_en"), topic("keep_me")],
            {},
            DEFAULT_DREAM_OPTIONS,
            NOW.getTime(),
        );
        const actions = submit([
            {
                action: "merge",
                sourceIds: ["user_role_zh", "user_role_en"],
                id: "userrolezh",
                name: "merged",
                description: "merged facts",
                type: "user",
                content: "merged",
            },
        ]);
        const resolved = resolveActionIds(actions, views);
        assert.equal(resolved[0]?.id, "userrolezh");
        assert.equal(validateDreamPlan(resolved, views).ok, true);
    });
});

// ─── conflicting actions ──────────────────────────────────────────────────────

describe("dream plan conflicts", () => {
    it("drops the action that touches a topic an earlier one claimed", () => {
        const actions: DreamAction[] = [
            {
                action: "merge",
                sourceIds: ["a", "b"],
                id: "ab",
                name: "n",
                description: "d",
                type: "project",
                content: "c",
            },
            { action: "rewrite", id: "a", content: "x" },
            { action: "rewrite", id: "c", content: "y" },
        ];
        const trimmed = trimConflictingActions(actions);
        assert.equal(trimmed.dropped, 1);
        assert.deepEqual(
            trimmed.actions.map((action) => action.id),
            ["ab", "c"],
        );
    });

    it("drops archives that depend on a merge removed for a conflict", () => {
        const rewrite: DreamAction = { action: "rewrite", id: "a", content: "x" };
        const merge: DreamAction = {
            action: "merge",
            sourceIds: ["a", "b"],
            id: "ab",
            name: "n",
            description: "d",
            type: "project",
            content: "c",
        };
        const archive: DreamAction = {
            action: "archive",
            id: "c",
            reason: "covered",
            supersededBy: "ab",
        };
        for (const actions of [
            [rewrite, merge, archive],
            [archive, rewrite, merge],
        ]) {
            const trimmed = trimConflictingActions(actions);
            assert.equal(trimmed.dropped, 2);
            assert.deepEqual(trimmed.actions, [rewrite]);
        }
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

    it("only allows undoing the most recent applied report", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { now: fixedNow });
        const first = await applyPendingDream(store, fixedNow);
        await store.updateTopic("c", "new input");
        await runDream(
            fakeDeps(store, {
                actions: [{ action: "rewrite", id: "c", content: "new rewrite" }],
            }),
            {
                force: true,
                previewOnly: true,
                now: () => new Date(NOW.getTime() + 1_000),
            },
        );
        const second = await applyPendingDream(store, () => new Date(NOW.getTime() + 1_000));
        assert.notEqual(first.id, second.id);
        await assert.rejects(
            () => undoDreamReport(store, first.id),
            /only the most recent consolidation can be undone/,
        );
        assert.deepEqual(await undoDreamReport(store, second.id), []);
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
                return dreamResponse(plan);
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

    it("skips without failing when no default model is configured", async () => {
        // A setup gap must not count toward the failure breaker and disable
        // the job before the user has added a key.
        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: () => undefined,
        });
        assert.equal(result.summary, NO_MODEL_SUMMARY);
        assert.deepEqual(result.outcomes, []);
    });

    it("announces an archive cleanup even when no default model is configured", async () => {
        const store = storeFor("cleanup-only");
        await seed(store, [topic("a"), topic("b"), topic("c")]);
        await store.archiveTopic("a");
        const archived = join(store.topicDir, "archive", "a.md");
        writeFileSync(
            archived,
            readFileSync(archived, "utf8").replace(
                /^archivedAt: .*$/m,
                "archivedAt: 2020-01-01T00:00:00.000Z",
            ),
        );
        const changed: string[] = [];

        await runDreamJob(
            {
                memoryEnabled: () => true,
                resolveModel: () => undefined,
                listDirKeys: () => [store.dirKey],
                onWorkspaceChanged: (dirKey) => changed.push(dirKey),
            },
            { options: { archiveCleanupEnabled: true, archiveRetentionDays: 7 } },
        );

        assert.deepEqual(changed, [store.dirKey]);
        assert.equal(existsSync(archived), false);
    });

    it("a workspace backing off waits behind the others", async () => {
        const failing = storeFor("failing");
        const healthy = storeFor("healthy");
        await seed(failing, ten());
        await seed(healthy, ten());
        recordDreamFailure(failing.topicDir);
        const model = modelReturning({ actions: [] });
        const result = await runDreamJob(
            {
                memoryEnabled: () => true,
                resolveModel: model.resolve,
                listDirKeys: () => [failing.dirKey, healthy.dirKey],
            },
            { force: true },
        );
        assert.deepEqual(
            result.outcomes.map((o) => o.dirKey),
            [healthy.dirKey, failing.dirKey],
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
        const changed: string[] = [];
        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: modelReturning(mergePlan).resolve,
            onWorkspaceChanged: (dirKey) => changed.push(dirKey),
        });
        assert.match(result.summary, /^1 consolidated \(merged 2→1, archived 0, rewrote 1\)$/);
        assert.equal(a.getTopic("ab")?.content, "a and b");
        assert.deepEqual(changed, [a.dirKey]);
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
            /1 failed: expected exactly one submit_memory_dream_plan tool call/,
        );
    });

    it("reports when no workspace exists", async () => {
        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: modelReturning(mergePlan).resolve,
            listDirKeys: () => [],
        });
        assert.equal(result.summary, "skipped: no memory workspaces found");
    });

    it("reports the reason when every workspace is skipped", async () => {
        const store = storeFor("too-small");
        await seed(store, [topic("only")]);
        const result = await runDreamJob({
            memoryEnabled: () => true,
            resolveModel: modelReturning(mergePlan).resolve,
            listDirKeys: () => [store.dirKey],
        });
        assert.equal(result.summary, "skipped: only 1 topics");
    });
});

// ─── review fixes ─────────────────────────────────────────────────────────────

describe("dream review fixes", () => {
    it("rejects oversized content and action arrays without cutting or dropping items", () => {
        const rewrite = { action: "rewrite", id: "a", content: "short" };
        assert.throws(() =>
            submit([{ ...rewrite, content: "x".repeat(MEMORY_CONTENT_MAX_CHARS + 1) }]),
        );
        assert.throws(() => submit(Array.from({ length: 41 }, () => rewrite)));
        assert.equal(
            submit(Array.from({ length: 40 }, (_, index) => ({ ...rewrite, id: `r${index}` })))
                .length,
            40,
        );
    });

    it("rejects an oversized Unicode action before any mixed plan can apply", async () => {
        const store = mkStore();
        await seed(store, ten());
        markDreamConfirmed(store.topicDir);
        const outcome = await runDream(
            fakeDeps(store, {
                actions: [
                    { action: "rewrite", id: "a", content: "valid replacement" },
                    { action: "rewrite", id: "b", content: "😀".repeat(1001) },
                ],
            }),
            { force: true, now: fixedNow },
        );
        assert.equal(outcome.status, "failed");
        assert.equal(store.getTopic("a")?.content, "content of a");
        assert.equal(readPendingDream(store), undefined);
        assert.equal(readLastDreamAt(store.topicDir), 0);
    });

    it("an archive waiting on a skipped merge is skipped too", async () => {
        const store = mkStore();
        await seed(store, ten());
        markDreamConfirmed(store.topicDir);
        const plan = {
            actions: [
                {
                    action: "merge",
                    sourceIds: ["a", "b"],
                    id: "ab",
                    name: "AB",
                    description: "Merged facts",
                    type: "project",
                    content: "a and b",
                },
                { action: "archive", id: "c", reason: "covered", supersededBy: "ab" },
            ],
        };
        const base = fakeDeps(store, plan);
        // Edit a merge source after planning starts, so the merge CAS fails.
        const deps: DreamDeps = {
            ...base,
            models: {
                completeSimple: async (...args: Parameters<Models["completeSimple"]>) => {
                    const res = await base.models.completeSimple(...args);
                    await store.updateTopic("a", "edited by the user");
                    return res;
                },
            } as unknown as Models,
        };
        const outcome = await runDream(deps, { force: true, now: fixedNow });
        assert.equal(outcome.status, "applied");
        if (outcome.status !== "applied") return;
        assert.deepEqual([...outcome.report.skipped].sort(), ["ab", "c"]);
        assert.ok(store.getTopic("c"), "c keeps its fact: its replacement never landed");
        assert.ok(store.getTopic("a") && store.getTopic("b"), "merge sources are back");
    });

    it("a run's own writes do not count as churn for the next gate", async () => {
        const store = mkStore();
        const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
        await seed(
            store,
            ten().map((t) => ({ ...t, createdAt: monthAgo })),
        );
        markDreamConfirmed(store.topicDir);
        const rewriteAll = {
            actions: ["a", "b", "c", "d", "e"].map((id) => ({
                action: "rewrite",
                id,
                content: `tight ${id}`,
            })),
        };
        const first = await runDream(fakeDeps(store, rewriteAll), { force: true });
        assert.equal(first.status, "applied");
        // Move the stamp back past the time gate, keeping it after the rewrites.
        const stamp = join(store.topicDir, ".dream", "last-run");
        const after = statSync(stamp).mtime;
        const shifted = new Date(after.getTime() + 1000);
        utimesSync(stamp, shifted, shifted);
        const gate = dreamGateReason(
            store.topicDir,
            store.listTopics(),
            { ...DEFAULT_DREAM_OPTIONS, minHours: 0 },
            Date.now() + 2000,
        );
        assert.equal(gate, undefined);
    });

    it("a scheduled failure backs off; a manual one does not", async () => {
        const store = mkStore();
        await seed(store, ten());
        const broken = fakeDeps(store, "not json at all");
        const failed = await runDream(broken, { now: fixedNow });
        assert.equal(failed.status, "failed");
        assert.ok(dreamRetryAt(store.topicDir) > Date.now(), "a backoff is recorded");
        const gated = await runDream(broken, { now: fixedNow });
        assert.equal(gated.status, "skipped");
        if (gated.status === "skipped") assert.match(gated.reason, /backing off/);

        const other = mkStoreAt("/ws/dream-manual");
        await seed(other, ten());
        await runDream(fakeDeps(other, "not json"), { force: true, now: fixedNow });
        assert.equal(dreamRetryAt(other.topicDir), 0);
    });

    it("an aborted model call fails the run and releases the lock", async () => {
        const store = mkStore();
        await seed(store, ten());
        const deps: DreamDeps = {
            ...fakeDeps(store, mergePlan),
            models: {
                completeSimple: (_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) =>
                    new Promise((_resolve, reject) => {
                        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                    }),
            } as unknown as Models,
        };
        const controller = new AbortController();
        const pending = runDream(deps, { force: true, signal: controller.signal, now: fixedNow });
        controller.abort();
        const outcome = await pending;
        assert.equal(outcome.status, "failed");
        if (outcome.status === "failed") assert.match(outcome.reason, /cancelled/);
        assert.equal(isDreamLocked(store.topicDir), false);
    });

    it("keeps the prompt within budget by leaving out the least active topics", () => {
        const views = buildTopicViews(
            [
                topic("fresh", { createdAt: new Date(NOW.getTime() - DAY).toISOString() }),
                topic("old", { createdAt: new Date(NOW.getTime() - 90 * DAY).toISOString() }),
            ],
            {},
            DEFAULT_DREAM_OPTIONS,
            NOW.getTime(),
        );
        const one = JSON.stringify(views[0]).length + 1;
        const picked = selectTopicsForPrompt(views, one + 5);
        assert.deepEqual(
            picked.views.map((v) => v.id),
            ["fresh"],
        );
        assert.equal(picked.omitted, 1);
        assert.equal(selectTopicsForPrompt(views).omitted, 0);
    });

    it("undo refuses a report from before undo support and runs under the lock", async () => {
        const store = mkStore();
        await seed(store, ten());
        const dreamDir = join(store.topicDir, ".dream", "reports");
        mkdirSync(dreamDir, { recursive: true });
        writeFileSync(
            join(dreamDir, "legacy.json"),
            JSON.stringify({
                id: "legacy",
                appliedAt: NOW.toISOString(),
                counts: { merged: 0, mergedInto: 0, rewritten: 1, archived: 0 },
                created: [],
                archived: [],
                rewritten: [{ id: "a", before: "x" }],
                skipped: [],
            }),
        );
        await assert.rejects(undoDreamReport(store, "legacy"), /predates undo support/);
        assert.equal(store.getTopic("a")?.content, "content of a");

        assert.equal(tryAcquireDreamLock(store.topicDir), true);
        await assert.rejects(undoDreamReport(store, "legacy"), /predates|running/);
        rollbackDreamLock(store.topicDir);
    });

    it("re-archiving an id keeps the earlier archived copy", async () => {
        const store = mkStore();
        await seed(store, [topic("dup", { content: "first" })]);
        await store.archiveTopic("dup");
        await store.appendEntry(topic("dup", { content: "second" }));
        await store.archiveTopic("dup");
        assert.equal(store.listArchivedTopics().find((t) => t.id === "dup")?.content, "second");
        const historyDir = join(store.topicDir, "archive", "history");
        const kept = readdirSync(historyDir);
        assert.equal(kept.length, 1);
        assert.match(readFileSync(join(historyDir, kept[0] ?? ""), "utf8"), /first/);
    });

    it("prunes old reports and dead usage entries", async () => {
        const store = mkStore();
        await seed(store, ten());
        for (let i = 0; i < KEPT_DREAM_REPORTS + 3; i++) {
            writeDreamReport(store.topicDir, { id: `r-${String(i).padStart(3, "0")}` });
        }
        assert.equal(listDreamReportIds(store.topicDir).length, KEPT_DREAM_REPORTS);
        assert.equal(
            listDreamReportIds(store.topicDir)[0],
            `r-${String(KEPT_DREAM_REPORTS + 2).padStart(3, "0")}`,
        );

        recordTopicUsage(store.topicDir, { a: NOW.toISOString(), gone: NOW.toISOString() });
        await runDream(fakeDeps(store, { actions: [] }), { force: true, now: fixedNow });
        assert.deepEqual(Object.keys(readTopicUsage(store.topicDir)), ["a"]);
    });
});

describe("LocalMemoryStore review fixes", () => {
    it("sees an in-place edit of a topic file, even with the dir mtime unchanged", async () => {
        const store = mkStore();
        await seed(store, [topic("live", { content: "before" })]);
        assert.equal(store.getTopic("live")?.content, "before");
        const file = join(store.topicDir, "live.md");
        const dirStat = statSync(store.topicDir);
        writeFileSync(file, readFileSync(file, "utf8").replace("before", "after, longer"));
        utimesSync(store.topicDir, dirStat.atime, dirStat.mtime);
        assert.equal(store.getTopic("live")?.content, "after, longer");
        // A CAS against the stale content is now refused.
        await assert.rejects(
            store.updateTopic("live", "extractor", { expectedContent: "before" }),
            /changed since it was read/,
        );
    });

    it("a write returns exactly what the next read sees", async () => {
        const store = mkStore();
        await seed(store, [topic("ws")]);
        const saved = await store.updateTopic("ws", "  padded content \n\n");
        assert.equal(saved.content, store.getTopic("ws")?.content);
        await store.updateTopic("ws", "next", { expectedContent: saved.content });
    });

    it("a newline or fence in a name cannot corrupt the topic file", async () => {
        const store = mkStore();
        await seed(store, [
            topic("evil", { name: "line one\n---\ntype: user", description: "a\nb" }),
        ]);
        const read = store.getTopic("evil");
        assert.ok(read);
        assert.equal(read.type, "project");
        assert.equal(read.content, "content of evil");
        assert.equal(read.name, "line one --- type: user");
    });
});

describe("dream maintenance quality", () => {
    const sourceA = {
        sessionId: "session-a",
        recordedAt: "2026-10-01T00:00:00.000Z",
        via: "auto" as const,
    };
    const sourceB = {
        sessionId: "session-b",
        recordedAt: "2026-10-02T00:00:00.000Z",
        via: "tool" as const,
        entryId: "original",
    };

    function editFrontmatter(
        store: LocalMemoryStore,
        id: string,
        field: string,
        value: string,
    ): void {
        const path = join(store.topicDir, `${id}.md`);
        writeFileSync(
            path,
            readFileSync(path, "utf8").replace(
                new RegExp(`^${field}:.*$`, "m"),
                `${field}: ${value}`,
            ),
        );
    }

    it("validates optional rewrite metadata without truncating it", () => {
        const rewrite = {
            action: "rewrite",
            id: "a",
            content: "## Theme\n- Fact",
            name: "n".repeat(60),
            description: "d".repeat(120),
        };
        assert.deepEqual(submit([rewrite]), [rewrite]);
        assert.throws(() => submit([{ ...rewrite, name: "n".repeat(61) }]));
        assert.throws(() => submit([{ ...rewrite, description: "d".repeat(121) }]));
    });

    it("prompts for focused Markdown themes within the shared 2000 character cap", async () => {
        const store = mkStore();
        await seed(store, ten());
        const deps = fakeDeps(store, { actions: [] });
        let prompt = "";
        const models = {
            completeSimple: async (_model: unknown, context: { systemPrompt: string }) => {
                prompt = context.systemPrompt;
                return dreamResponse({ actions: [] });
            },
        } as unknown as Models;
        await runDream({ ...deps, models }, { force: true, now: fixedNow });
        assert.match(prompt, /Markdown/);
        assert.match(prompt, /theme/);
        assert.match(prompt, /2000 characters/);
        assert.match(prompt, /"name".*optional/);
    });

    it("rejects model-invented provenance before planning writes", async () => {
        const store = mkStore();
        await seed(store, [topic("a", { sources: [sourceA] }), ...ten().slice(1)]);
        const outcome = await runDream(
            fakeDeps(store, {
                actions: [
                    { action: "rewrite", id: "a", content: "replacement", sources: [sourceB] },
                ],
            }),
            { force: true, now: fixedNow },
        );
        assert.equal(outcome.status, "failed");
        assert.equal(readPendingDream(store), undefined);
        assert.equal(store.getTopic("a")?.content, "content of a");
        assert.deepEqual(store.getTopic("a")?.sources, [sourceA]);
    });

    it("rewrites metadata and undo restores it alongside the original body and sources", async () => {
        const store = mkStore();
        await seed(store, [topic("a", { sources: [sourceA] }), topic("b"), topic("c")]);
        const original = store.getTopic("a");
        assert.ok(original);
        await runDream(
            fakeDeps(store, {
                actions: [
                    {
                        action: "rewrite",
                        id: "a",
                        content: "## Theme\n- Durable detail",
                        name: "Theme",
                        description: "Find durable detail here",
                    },
                ],
            }),
            { force: true, now: fixedNow },
        );
        const report = await applyPendingDream(store, fixedNow);
        assert.equal(store.getTopic("a")?.name, "Theme");
        assert.equal(store.getTopic("a")?.description, "Find durable detail here");
        assert.deepEqual(store.getTopic("a")?.sources, [sourceA]);
        assert.deepEqual(await undoDreamReport(store, report.id), []);
        assert.equal(store.getTopic("a")?.content, original.content);
        assert.equal(store.getTopic("a")?.name, original.name);
        assert.equal(store.getTopic("a")?.description, original.description);
        assert.deepEqual(store.getTopic("a")?.sources, [sourceA]);
    });

    it("merges only actual source provenance, deduplicating in stable order and retaining archive provenance on undo", async () => {
        const store = mkStore();
        await seed(store, [
            topic("a", { sources: [sourceB, sourceA] }),
            topic("b", { sources: [sourceA] }),
            ...ten().slice(2),
        ]);
        await runDream(
            fakeDeps(store, {
                actions: [
                    {
                        ...mergePlan.actions[0],
                        sourceIds: ["b", "a"],
                    },
                ],
            }),
            { force: true, now: fixedNow },
        );
        const report = await applyPendingDream(store, fixedNow);
        const mergedSources = store.getTopic("ab")?.sources;
        assert.deepEqual(mergedSources?.map((s) => s.sessionId).sort(), ["session-a", "session-b"]);
        assert.deepEqual(
            store
                .listArchivedTopics()
                .find((t) => t.id === "a")
                ?.sources?.map((s) => s.sessionId)
                .sort(),
            ["session-a", "session-b"],
        );
        assert.deepEqual(await undoDreamReport(store, report.id), []);
        assert.deepEqual(
            store
                .getTopic("a")
                ?.sources?.map((s) => s.sessionId)
                .sort(),
            ["session-a", "session-b"],
        );
        assert.deepEqual(
            store.listArchivedTopics().find((t) => t.id === "ab")?.sources,
            mergedSources,
        );
    });

    for (const action of ["rewrite", "merge", "archive"] as const) {
        it(`skips ${action} after a metadata-only edit while a preview waits`, async () => {
            const store = mkStore();
            await seed(
                store,
                ten().map((t) => ({
                    ...t,
                    createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
                })),
            );
            const actions =
                action === "merge"
                    ? [mergePlan.actions[0]]
                    : action === "rewrite"
                      ? [{ action, id: "a", content: "replacement", name: "New name" }]
                      : [{ action, id: "a", reason: "obsolete" }];
            await runDream(fakeDeps(store, { actions }), { force: true, now: fixedNow });
            editFrontmatter(store, "a", "name", "Concurrent title");
            const report = await applyPendingDream(store, fixedNow);
            assert.deepEqual(report.skipped, [action === "merge" ? "ab" : "a"]);
            assert.equal(store.getTopic("a")?.name, "Concurrent title");
            assert.equal(store.getTopic("a")?.content, "content of a");
        });
    }

    it("undo keeps later metadata-only edits to both merged and rewritten topics", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { force: true, now: fixedNow });
        const report = await applyPendingDream(store, fixedNow);
        editFrontmatter(store, "c", "description", "Later description");
        editFrontmatter(store, "ab", "name", "Later merged title");
        assert.deepEqual((await undoDreamReport(store, report.id)).sort(), ["ab", "c"]);
        assert.equal(store.getTopic("c")?.content, "c, tightened");
        assert.equal(store.getTopic("ab")?.name, "Later merged title");
    });

    it("allows a quiet maintenance pass at 30 days but retains time, minimum topics, backoff and preview gates", async () => {
        const store = mkStore();
        const now = Date.now();
        await seed(
            store,
            ten().map((t) => ({ ...t, createdAt: new Date(now - 100 * DAY).toISOString() })),
        );
        tryAcquireDreamLock(store.topicDir);
        releaseDreamLock(store.topicDir, new Date(now - 30 * DAY));
        assert.equal(
            dreamGateReason(store.topicDir, store.listTopics(), DEFAULT_DREAM_OPTIONS, now),
            undefined,
        );
        assert.match(
            dreamGateReason(
                store.topicDir,
                store.listTopics(),
                { ...DEFAULT_DREAM_OPTIONS, minHours: 1000 },
                now,
            ) ?? "",
            /last run/,
        );
        assert.match(
            dreamGateReason(
                store.topicDir,
                store.listTopics().slice(0, 2),
                DEFAULT_DREAM_OPTIONS,
                now,
            ) ?? "",
            /only 2/,
        );
        recordDreamFailure(store.topicDir, new Date(now));
        assert.match(
            dreamGateReason(store.topicDir, store.listTopics(), DEFAULT_DREAM_OPTIONS, now) ?? "",
            /backing off/,
        );
    });

    it("allows a scheduled run after the time interval even with zero topic changes", async () => {
        const store = mkStore();
        await seed(store, ten());
        const now = Date.now();
        tryAcquireDreamLock(store.topicDir);
        releaseDreamLock(store.topicDir, new Date(now - 25 * 60 * 60 * 1000));
        assert.equal(
            dreamGateReason(store.topicDir, store.listTopics(), DEFAULT_DREAM_OPTIONS, now),
            undefined,
        );
    });

    it("journals partial merges and rolls back original source provenance when target creation fails", async () => {
        const store = mkStore();
        await seed(store, [
            topic("a", { sources: [sourceA] }),
            topic("b", { sources: [sourceB] }),
            ...ten().slice(2),
        ]);
        await runDream(fakeDeps(store, { actions: [mergePlan.actions[0]] }), {
            force: true,
            now: fixedNow,
        });
        const plan = readPendingDream(store);
        assert.ok(plan);
        const append = store.appendEntry.bind(store);
        store.appendEntry = async (entry) => {
            if (entry.id !== "ab") return append(entry);
            const journal = readDreamReport<{
                stranded?: string[];
                beforeEntries?: Record<string, MemoryEntry>;
                inProgress?: boolean;
            }>(store.topicDir, plan.id);
            assert.equal(journal?.inProgress, true);
            assert.deepEqual(journal?.stranded, ["a", "b"]);
            assert.deepEqual(journal?.beforeEntries?.a?.sources, [sourceA]);
            assert.deepEqual(journal?.beforeEntries?.b?.sources, [sourceB]);
            throw new Error("target creation failed");
        };
        const report = await applyPendingDream(store, fixedNow);
        assert.deepEqual(report.skipped, ["ab"]);
        assert.deepEqual(report.archived, []);
        assert.equal(report.stranded, undefined);
        assert.deepEqual(store.getTopic("a")?.sources, [sourceA]);
        assert.deepEqual(store.getTopic("b")?.sources, [sourceB]);
    });

    it("undo recovers stranded source provenance after a merge rollback fails", async () => {
        const store = mkStore();
        await seed(store, [
            topic("a", { sources: [sourceA] }),
            topic("b", { sources: [sourceB] }),
            ...ten().slice(2),
        ]);
        await runDream(fakeDeps(store, { actions: [mergePlan.actions[0]] }), {
            force: true,
            now: fixedNow,
        });
        const append = store.appendEntry.bind(store);
        const restore = store.restoreTopic.bind(store);
        store.appendEntry = async (entry) => {
            if (entry.id === "ab") throw new Error("target creation failed");
            return append(entry);
        };
        store.restoreTopic = async (id) => {
            if (id === "a") throw new Error("temporary restore failure");
            return restore(id);
        };
        const report = await applyPendingDream(store, fixedNow);
        assert.deepEqual(report.stranded, ["a"]);
        assert.equal(store.getTopic("a"), undefined);
        store.restoreTopic = restore;
        assert.deepEqual(await undoDreamReport(store, report.id), []);
        assert.deepEqual(store.getTopic("a")?.sources, [sourceA]);
        assert.deepEqual(store.getTopic("b")?.sources, [sourceB]);
    });

    for (const action of ["merge", "archive"] as const) {
        it(`${action} reports the validated original when its archived file changes before the await resumes`, async () => {
            const store = mkStore();
            await seed(store, [
                topic("a", {
                    sources: [sourceA],
                    createdAt: new Date(NOW.getTime() - 200 * DAY).toISOString(),
                }),
                ...ten().slice(1),
            ]);
            const original = store.getTopic("a");
            assert.ok(original);
            const actions =
                action === "merge"
                    ? [mergePlan.actions[0]]
                    : [{ action: "archive", id: "a", reason: "obsolete" }];
            await runDream(fakeDeps(store, { actions }), { force: true, now: fixedNow });
            const archive = store.archiveTopic.bind(store);
            store.archiveTopic = async (id, options) => {
                const archived = await archive(id, options);
                if (id === "a") {
                    const path = join(store.topicDir, "archive", "a.md");
                    writeFileSync(
                        path,
                        readFileSync(path, "utf8")
                            .replace(/^name:.*$/m, "name: Replaced archived copy")
                            .replace(/^sources:.*$/m, `sources: ${JSON.stringify([sourceB])}`),
                    );
                }
                return archived;
            };
            const report = await applyPendingDream(store, fixedNow);
            assert.deepEqual(report.beforeEntries?.a, original);
            if (action === "merge") assert.deepEqual(store.getTopic("ab")?.sources, [sourceA]);
            assert.deepEqual(await undoDreamReport(store, report.id), ["a"]);
            assert.equal(store.getTopic("a"), undefined);
            assert.deepEqual(
                store.listArchivedTopics().find((entry) => entry.id === "a")?.sources,
                [sourceB],
            );
        });
    }

    it("passes plain entry snapshots to store CAS for apply and undo", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(
            fakeDeps(store, {
                actions: [
                    {
                        action: "rewrite",
                        id: "a",
                        content: "dream body",
                        name: "Dream title",
                        description: "Dream summary",
                    },
                ],
            }),
            { force: true, now: fixedNow },
        );
        const update = store.updateTopic.bind(store);
        const seen: unknown[] = [];
        store.updateTopic = async (id, content, options) => {
            seen.push({
                name: options?.expectedEntry?.name,
                description: options?.expectedEntry?.description,
                content: options?.expectedEntry?.content,
                getter:
                    Object.getOwnPropertyDescriptor(options ?? {}, "expectedContent")?.get !==
                    undefined,
            });
            return update(id, content, options);
        };
        const report = await applyPendingDream(store, fixedNow);
        await undoDreamReport(store, report.id);
        assert.deepEqual(seen, [
            { name: "Name a", description: "About a", content: "content of a", getter: false },
            {
                name: "Dream title",
                description: "Dream summary",
                content: "dream body",
                getter: false,
            },
        ]);
    });

    for (const phase of ["undo", "rollback"] as const) {
        it(`${phase} rejects an archived metadata edit queued just before restore`, async () => {
            const store = mkStore();
            await seed(store, [topic("a", { sources: [sourceA] }), ...ten().slice(1)]);
            await runDream(fakeDeps(store, { actions: [mergePlan.actions[0]] }), {
                force: true,
                now: fixedNow,
            });
            const restore = store.restoreTopic.bind(store);
            store.restoreTopic = (id, options) => {
                if (id === "a") {
                    // This write happens after dream has submitted the restore,
                    // before LocalMemoryStore executes its queued mutation.
                    queueMicrotask(() => {
                        const path = join(store.topicDir, "archive", "a.md");
                        writeFileSync(
                            path,
                            readFileSync(path, "utf8").replace(
                                /^name:.*$/m,
                                "name: Queued archive edit",
                            ),
                        );
                    });
                }
                return restore(id, options);
            };
            if (phase === "rollback") {
                store.appendEntry = async () => {
                    throw new Error("merge target failed");
                };
            }
            const report = await applyPendingDream(store, fixedNow);
            if (phase === "undo") {
                assert.deepEqual(await undoDreamReport(store, report.id), ["a"]);
            } else {
                assert.deepEqual(report.stranded, ["a"]);
            }
            assert.equal(store.getTopic("a"), undefined);
            assert.equal(
                store.listArchivedTopics().find((entry) => entry.id === "a")?.name,
                "Queued archive edit",
            );
        });
    }

    it("unions provenance independently of model source ordering", async () => {
        const results: unknown[] = [];
        for (const sourceIds of [
            ["a", "b"],
            ["b", "a"],
        ]) {
            const store = mkStoreAt(`/ws/order-${sourceIds[0]}`);
            await seed(store, [
                topic("a", { sources: [sourceA] }),
                topic("b", { sources: [sourceB] }),
                ...ten().slice(2),
            ]);
            await runDream(fakeDeps(store, { actions: [{ ...mergePlan.actions[0], sourceIds }] }), {
                force: true,
                now: fixedNow,
            });
            await applyPendingDream(store, fixedNow);
            results.push(store.getTopic("ab")?.sources);
        }
        assert.deepEqual(results[0], results[1]);
    });

    it("checks metadata inside the store write tick after an already queued edit", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(
            fakeDeps(store, {
                actions: [
                    { action: "rewrite", id: "a", content: "dream body", name: "Dream title" },
                ],
            }),
            { force: true, now: fixedNow },
        );
        const userEdit = store.updateTopic("a", "content of a", { name: "Queued user title" });
        const report = await applyPendingDream(store, fixedNow);
        await userEdit;
        assert.deepEqual(report.skipped, ["a"]);
        assert.equal(store.getTopic("a")?.name, "Queued user title");
        assert.equal(store.getTopic("a")?.content, "content of a");
    });

    it("undo does not restore an archived copy replaced by a later archive", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { force: true, now: fixedNow });
        const report = await applyPendingDream(store, fixedNow);
        await store.appendEntry(topic("a", { name: "New incarnation", sources: [sourceB] }));
        await store.archiveTopic("a");
        assert.deepEqual(await undoDreamReport(store, report.id), ["a"]);
        assert.equal(store.getTopic("a"), undefined);
        assert.equal(store.listArchivedTopics().find((t) => t.id === "a")?.name, "New incarnation");
    });

    it("skips a preview when only its provenance changed", async () => {
        const store = mkStore();
        await seed(store, [topic("a", { sources: [sourceA] }), ...ten().slice(1)]);
        await runDream(fakeDeps(store, mergePlan), { force: true, now: fixedNow });
        await store.updateTopic("a", "content of a", { sources: [sourceB] });
        const report = await applyPendingDream(store, fixedNow);
        assert.deepEqual(report.skipped, ["ab"]);
        assert.deepEqual(store.getTopic("a")?.sources, [sourceA, sourceB]);
    });

    it("undo preserves provenance appended after a rewrite", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { force: true, now: fixedNow });
        const report = await applyPendingDream(store, fixedNow);
        await store.updateTopic("c", "c, tightened", { sources: [sourceB] });
        assert.deepEqual(await undoDreamReport(store, report.id), ["c"]);
        assert.deepEqual(store.getTopic("c")?.sources, [sourceB]);
        assert.equal(store.getTopic("c")?.content, "c, tightened");
    });

    it("undo preserves a merge edited immediately after creation", async () => {
        const store = mkStore();
        await seed(store, ten());
        await runDream(fakeDeps(store, mergePlan), { force: true, now: fixedNow });
        const append = store.appendEntry.bind(store);
        store.appendEntry = async (entry) => {
            await append(entry);
            if (entry.id === "ab")
                await store.updateTopic("ab", entry.content, { name: "User edited title" });
        };
        const report = await applyPendingDream(store, fixedNow);
        assert.deepEqual(await undoDreamReport(store, report.id), ["ab"]);
        assert.equal(store.getTopic("ab")?.name, "User edited title");
    });

    it("advances rotation after successful no-op plans and preserves it after failed calls", async () => {
        const store = mkStore();
        await seed(store, ten());
        assert.equal(readDreamSelectionRound(store.topicDir), 0);
        await runDream(fakeDeps(store, { actions: [] }), { force: true, now: fixedNow });
        assert.equal(readDreamSelectionRound(store.topicDir), 1);
        await runDream(fakeDeps(store, "not JSON"), { force: true, now: fixedNow });
        assert.equal(readDreamSelectionRound(store.topicDir), 1);
        await runDream(fakeDeps(LocalMemoryStore.openByKey(store.dirKey), { actions: [] }), {
            force: true,
            now: fixedNow,
        });
        assert.equal(readDreamSelectionRound(store.topicDir), 2);
    });

    it("a pending preview still blocks a quiet workspace after 30 days", async () => {
        const store = mkStore();
        await seed(store, ten());
        const deps = fakeDeps(store, mergePlan);
        await runDream(deps, { force: true, now: fixedNow });
        const stamp = join(store.topicDir, ".dream", "last-run");
        const old = new Date(Date.now() - 31 * DAY);
        utimesSync(stamp, old, old);
        const outcome = await runDream(deps);
        assert.equal(outcome.status, "skipped");
        if (outcome.status === "skipped") assert.match(outcome.reason, /preview awaits/);
        assert.equal(deps.calls, 1);
    });

    it("eventually selects every topic across 300 rounds at the production prompt budget", () => {
        const entries = Array.from({ length: 300 }, (_, i) =>
            topic(`topic-${i.toString().padStart(3, "0")}`, {
                content: "x".repeat(MEMORY_CONTENT_MAX_CHARS),
                createdAt: new Date(NOW.getTime() - (i + 1) * DAY).toISOString(),
            }),
        );
        const views = buildTopicViews(entries, {}, DEFAULT_DREAM_OPTIONS, NOW.getTime());
        const seen = new Set<string>();
        for (let round = 0; round < views.length; round++) {
            const selection = selectTopicsForPrompt(views, DREAM_PROMPT_BUDGET_CHARS, round);
            assert.ok(selection.omitted > 0, "exercise an oversubscribed production prompt");
            assert.ok(
                selection.views.reduce((sum, view) => sum + JSON.stringify(view).length + 1, 0) <=
                    DREAM_PROMPT_BUDGET_CHARS,
            );
            assert.ok(
                selection.views.some((view) => view.id === "topic-000"),
                "retain the hottest topic in each run",
            );
            for (const view of selection.views) seen.add(view.id);
        }
        assert.deepEqual(
            views.filter((view) => !seen.has(view.id)).map((view) => view.id),
            [],
            "middle-ranked topics must not starve",
        );
    });

    it("reserves budget for cold topics and rotates them deterministically across runs", () => {
        const entries = Array.from({ length: 12 }, (_, i) =>
            topic(`t${i.toString().padStart(2, "0")}`, {
                createdAt: new Date(NOW.getTime() - (i < 6 ? 1 : 200) * DAY).toISOString(),
            }),
        );
        const views = buildTopicViews(entries, {}, DEFAULT_DREAM_OPTIONS, NOW.getTime());
        const budget = (JSON.stringify(views[0]).length + 1) * 4 + 20;
        const first = selectTopicsForPrompt(views, budget, 0);
        const second = selectTopicsForPrompt(views, budget, 1);
        assert.ok(
            first.views.some((v) => v.stale),
            "cold topics must receive space even while hot ones compete",
        );
        assert.ok(
            first.views.some((v) => !v.stale),
            "recent topics still get space",
        );
        assert.notDeepEqual(
            first.views.map((v) => v.id),
            second.views.map((v) => v.id),
        );
        assert.deepEqual(selectTopicsForPrompt(views, budget, 1), second);
        assert.ok(first.views.reduce((sum, v) => sum + JSON.stringify(v).length + 1, 0) <= budget);
    });
});
