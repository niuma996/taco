/**
 * Built-in scheduled jobs: the memory-dream job's seed, the rules that keep a
 * system job safe inside the user-editable jobs CRUD (store migration,
 * controller create / update / delete, dispatcher routing), the args
 * validator, and history summaries from native handlers.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { JobsScopeError } from "../../src/lib/jobsErrors.ts";
import {
    defaultMemoryDreamJob,
    isBuiltinJob,
    MEMORY_DREAM_COMMAND,
    MEMORY_DREAM_JOB_ID,
    parseMemoryDreamArgs,
} from "../../src/scheduler/builtinJobs.ts";
import {
    createJobDispatcher,
    UnsupportedScheduledCommand,
} from "../../src/scheduler/dispatcher.ts";
import { JobsController } from "../../src/scheduler/jobsController.ts";
import { Scheduler } from "../../src/scheduler/runner.ts";
import { JobStore } from "../../src/scheduler/store.ts";
import type { Job } from "../../src/scheduler/types.ts";

/** Schedulers created by `setup`; stopped after each test so an enabled cron
 *  job's timer cannot keep the process alive. */
const schedulers: Scheduler[] = [];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "taco-builtin-jobs-"));
    try {
        return await fn(dir);
    } finally {
        for (const scheduler of schedulers.splice(0)) scheduler.stop();
        await rm(dir, { recursive: true, force: true });
    }
}

function userJob(id: string, overrides: Partial<Job> = {}): Job {
    return {
        id,
        name: id,
        schedule: { kind: "interval", ms: 60_000 },
        command: "agent.invoke",
        args: { workspace: "/ws", prompt: "hi" },
        enabled: false,
        run_on_startup: false,
        history: [],
        ...overrides,
    };
}

async function setup(dir: string, invoke: (job: Job) => Promise<unknown> = async () => undefined) {
    const store = new JobStore(dir);
    const scheduler = new Scheduler({
        store,
        lockDir: dir,
        invoke: invoke as never,
    });
    schedulers.push(scheduler);
    const ctrl = new JobsController(store, scheduler, dir);
    return { store, scheduler, ctrl };
}

describe("built-in job seed", () => {
    test("the default memory-dream job is on, nightly, catch-up, and built-in", () => {
        const job = defaultMemoryDreamJob();
        strictEqual(job.id, MEMORY_DREAM_JOB_ID);
        strictEqual(job.command, MEMORY_DREAM_COMMAND);
        strictEqual(job.enabled, true);
        strictEqual(job.run_on_startup, true);
        strictEqual(job.builtin, true);
        deepStrictEqual(job.schedule, { kind: "cron", expr: "17 4 * * *" });
        strictEqual(job.args.workspace, undefined, "a built-in targets no workspace");
        ok(isBuiltinJob(job));
    });

    test("seedBuiltin creates once; a user-edited copy survives the next boot", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            const seeded = await ctrl.seedBuiltin(defaultMemoryDreamJob());
            strictEqual(seeded.enabled, true);

            await ctrl.update({
                ...seeded,
                enabled: false,
                schedule: { kind: "cron", expr: "0 3 * * *" },
            });
            const again = await ctrl.seedBuiltin(defaultMemoryDreamJob());
            strictEqual(again.enabled, false, "the user's disable is kept");
            deepStrictEqual(again.schedule, { kind: "cron", expr: "0 3 * * *" });
        });
    });

    test("a freshly seeded built-in does not replay on the first boot", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            const before = Date.now();
            const seeded = await ctrl.seedBuiltin(defaultMemoryDreamJob());
            ok(seeded.last_run_at, "seeded with a last run");
            ok(Date.parse(seeded.last_run_at) >= before - 1000);
        });
    });

    test("seedBuiltin refuses a non-built-in job", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            await rejects(() => ctrl.seedBuiltin(userJob("x")), /not a built-in job/);
        });
    });
});

describe("built-in job protection", () => {
    test("the API cannot create a built-in, nor a user job with a built-in command", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            await rejects(
                () => ctrl.create({ ...defaultMemoryDreamJob(), id: "" }),
                (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
            );
            await rejects(
                () => ctrl.create(userJob("", { command: MEMORY_DREAM_COMMAND })),
                (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
            );
        });
    });

    test("a built-in cannot be deleted, only disabled", async () => {
        await withTmp(async (dir) => {
            const { ctrl, store } = await setup(dir);
            await ctrl.seedBuiltin(defaultMemoryDreamJob());
            await rejects(
                () => ctrl.delete(MEMORY_DREAM_JOB_ID),
                (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
            );
            ok(await store.get(MEMORY_DREAM_JOB_ID));
        });
    });

    test("a workspace-scoped actor neither sees nor learns about a built-in", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            await ctrl.seedBuiltin(defaultMemoryDreamJob());
            const actor = { kind: "ide", workspace: "/ws" } as const;
            deepStrictEqual(await ctrl.list(actor), []);
            strictEqual(await ctrl.get(MEMORY_DREAM_JOB_ID, actor), null);
            // Out-of-scope delete is a silent no-op, not a "forbidden" leak.
            await ctrl.delete(MEMORY_DREAM_JOB_ID, actor);
        });
    });

    test("update keeps command and server fields; schedule, enabled, args are editable", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            const seeded = await ctrl.seedBuiltin(defaultMemoryDreamJob());
            await rejects(
                () => ctrl.update({ ...seeded, command: "agent.invoke" }),
                (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
            );
            const saved = await ctrl.update({
                ...seeded,
                name: "renamed",
                enabled: false,
                args: { minHours: 48 },
                run_count: 99,
                history: [{ started_at: "x", status: "ok" }],
            });
            strictEqual(saved.enabled, false);
            deepStrictEqual(saved.args, { minHours: 48 });
            strictEqual(saved.name, seeded.name, "name is fixed");
            strictEqual(saved.run_count, 0, "counters stay server-managed");
            deepStrictEqual(saved.history, []);
            strictEqual(saved.builtin, true);
        });
    });

    test("a user job cannot be turned into a built-in", async () => {
        await withTmp(async (dir) => {
            const { ctrl } = await setup(dir);
            const created = await ctrl.create(userJob(""));
            await rejects(
                () => ctrl.update({ ...created, builtin: true, command: MEMORY_DREAM_COMMAND }),
                (err: unknown) => err instanceof JobsScopeError && err.code === "forbidden",
            );
        });
    });

    test("the store's legacy-command migration leaves a built-in untouched", async () => {
        await withTmp(async (dir) => {
            const job = { ...defaultMemoryDreamJob(), generation: "g1" };
            await writeFile(join(dir, `${job.id}.json`), JSON.stringify(job));
            const store = new JobStore(dir);
            const read = await store.get(job.id);
            strictEqual(read?.command, MEMORY_DREAM_COMMAND);
            strictEqual(read?.args.prompt, undefined);
            const onDisk = JSON.parse(await readFile(join(dir, `${job.id}.json`), "utf8")) as Job;
            strictEqual(onDisk.command, MEMORY_DREAM_COMMAND);
        });
    });

    test("a user job that names a built-in command is still migrated, never routed", async () => {
        await withTmp(async (dir) => {
            const forged = userJob("forged", { command: MEMORY_DREAM_COMMAND, builtin: undefined });
            await writeFile(join(dir, "forged.json"), JSON.stringify(forged));
            const read = await new JobStore(dir).get("forged");
            strictEqual(read?.command, "agent.invoke");
        });
    });
});

describe("built-in dispatch", () => {
    test("routes built-ins to their handler and returns its summary", async () => {
        let seen: Job | undefined;
        const invoke = createJobDispatcher(
            () => {
                throw new Error("a built-in must not resolve a workspace server");
            },
            {
                builtinHandlers: new Map([
                    [
                        MEMORY_DREAM_COMMAND,
                        async (job: Job) => {
                            seen = job;
                            return { summary: "merged 4→2" };
                        },
                    ],
                ]),
            },
        );
        const result = await invoke(defaultMemoryDreamJob());
        deepStrictEqual(result, { summary: "merged 4→2" });
        strictEqual(seen?.id, MEMORY_DREAM_JOB_ID);
    });

    test("a built-in with no registered handler fails loudly", async () => {
        const invoke = createJobDispatcher(() => {
            throw new Error("unreachable");
        });
        await rejects(() => invoke(defaultMemoryDreamJob()), UnsupportedScheduledCommand);
    });

    test("a non-built-in job naming a built-in command is not routed to the handler", async () => {
        let called = false;
        const invoke = createJobDispatcher(
            () => ({ dispatchRpc: async () => ({ id: "x", ok: true, result: {} }) }) as never,
            {
                builtinHandlers: new Map([
                    [
                        MEMORY_DREAM_COMMAND,
                        async () => {
                            called = true;
                            return {};
                        },
                    ],
                ]),
            },
        );
        await rejects(
            () => invoke(userJob("x", { command: MEMORY_DREAM_COMMAND })),
            UnsupportedScheduledCommand,
        );
        strictEqual(called, false);
    });

    test("the runner writes a handler's summary onto the history entry", async () => {
        await withTmp(async (dir) => {
            const { ctrl, store, scheduler } = await setup(dir, async () => ({
                summary: "1 consolidated (merged 4→2, archived 1, rewrote 0)",
            }));
            await ctrl.seedBuiltin({ ...defaultMemoryDreamJob(), enabled: false });
            const result = await scheduler.runNow(MEMORY_DREAM_JOB_ID);
            strictEqual(result.status, "ok");
            const job = await store.get(MEMORY_DREAM_JOB_ID);
            strictEqual(job?.history[0]?.status, "ok");
            strictEqual(
                job?.history[0]?.summary,
                "1 consolidated (merged 4→2, archived 1, rewrote 0)",
            );
        });
    });
});

describe("parseMemoryDreamArgs", () => {
    test("accepts in-range integers and a model, drops unknown keys", () => {
        const parsed = parseMemoryDreamArgs({
            minHours: 12,
            minChanges: 0,
            staleDays: 30,
            staleDaysDurable: 365,
            model: "anthropic/claude",
            prompt: "ignored",
            workspace: "/ignored",
        });
        ok(parsed.ok);
        if (parsed.ok) {
            deepStrictEqual(parsed.args, {
                minHours: 12,
                minChanges: 0,
                staleDays: 30,
                staleDaysDurable: 365,
                model: "anthropic/claude",
            });
        }
    });

    test("rejects out-of-range, fractional, and non-number values", () => {
        for (const bad of [
            { minHours: 0 },
            { minHours: 1.5 },
            { staleDays: 3 },
            { minChanges: -1 },
            { staleDaysDurable: "180" },
            { model: 42 },
        ]) {
            const parsed = parseMemoryDreamArgs(bad as Record<string, unknown>);
            strictEqual(parsed.ok, false, JSON.stringify(bad));
        }
    });

    test("an empty model string means the default model", () => {
        const parsed = parseMemoryDreamArgs({ model: "" });
        ok(parsed.ok);
        if (parsed.ok) strictEqual(parsed.args.model, undefined);
    });
});
