/**
 * Scheduled fires as Work: the dispatcher records each agent turn before it
 * runs and settles it with what the turn produced; the runner points the
 * history entry at that Work, even when the fire itself timed out.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ErrorCodes, type RpcRequest, type RpcResponse } from "@taco-ai/protocol";
import type { QueuedOutcome, QueuedWatch } from "../../src/runtime/harness/queuedWatch.ts";
import type { AgentMessage } from "../../src/runtime/pi/types.ts";
import { createJobDispatcher } from "../../src/scheduler/dispatcher.ts";
import { Scheduler } from "../../src/scheduler/runner.ts";
import type { Job } from "../../src/scheduler/types.ts";
import type {
    ScheduledFire,
    ScheduledFireSettle,
    ScheduledWorkHooks,
} from "../../src/work/workHooks.ts";

class RecordingHooks implements ScheduledWorkHooks {
    readonly fires: ScheduledFire[] = [];
    readonly settles: { workId: string; settle: ScheduledFireSettle }[] = [];
    async onFire(fire: ScheduledFire): Promise<string | undefined> {
        this.fires.push(fire);
        return `w-${this.fires.length}`;
    }
    async onFireSettle(workId: string, settle: ScheduledFireSettle): Promise<void> {
        this.settles.push({ workId, settle });
    }
}

type Respond = (req: RpcRequest) => RpcResponse;

function server(respond: Respond, route?: string) {
    const calls: RpcRequest[] = [];
    return {
        calls,
        dispatchRpc: async (req: RpcRequest) => {
            calls.push(req);
            return respond(req);
        },
        lookupRoute: () => (route ? { sessionId: route } : undefined),
    };
}

const reply = (text: string) =>
    ({
        role: "assistant",
        content: [{ type: "text", text }],
    }) as unknown as AgentMessage;

class ManualWatch implements QueuedWatch {
    waits: string[] = [];
    stopped = false;
    private resolvers = new Map<string, (outcome: QueuedOutcome) => void>();
    wait(entryId: string): Promise<QueuedOutcome> {
        this.waits.push(entryId);
        return new Promise<QueuedOutcome>((resolve) => this.resolvers.set(entryId, resolve));
    }
    stop(): void {
        this.stopped = true;
    }
    settle(outcome: QueuedOutcome): void {
        for (const resolve of this.resolvers.values()) resolve(outcome);
        this.resolvers.clear();
    }
}

/** A busy IM session: prompt rejects, followUp queues entry "e-1". */
function busyServer(watch: ManualWatch | undefined, order: string[]) {
    const fake = server((req) => {
        if (req.method === "session.prompt") {
            order.push("prompt");
            return {
                id: req.id,
                ok: false,
                error: { code: ErrorCodes.SessionBusy, message: "busy" },
            } as RpcResponse;
        }
        if (req.method === "session.followUp") return ok(req, { mode: "queued", entryId: "e-1" });
        return ok(req, {});
    }, "im-session");
    return {
        ...fake,
        queueWatch: () => {
            order.push("watch");
            return watch;
        },
    };
}

const imJob = () =>
    job({
        args: { workspace: "im://wechat/peer/chat", prompt: "ping" },
        sessionStrategy: "reuse",
    });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const ok = (req: RpcRequest, result: unknown): RpcResponse =>
    ({ id: req.id, ok: true, result }) as RpcResponse;

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: "daily",
        name: "Daily digest",
        schedule: { kind: "interval", ms: 60_000 },
        command: "agent.invoke",
        args: { workspace: "/tmp/w", prompt: "summarize" },
        enabled: true,
        run_on_startup: false,
        history: [],
        sessionStrategy: "new",
        ...overrides,
    };
}

describe("dispatcher tracks agent fires as Work", () => {
    it("records the fire against its session before the turn and settles with the reply", async () => {
        const hooks = new RecordingHooks();
        let firedBeforeTurn = false;
        const fake = server((req) => {
            firedBeforeTurn = hooks.fires.length === 1;
            return ok(req, { sessionId: req.id, assistantMessage: reply("all quiet") });
        });
        const dispatch = createJobDispatcher(() => fake, { work: hooks });

        const result = await dispatch(job(), { fireId: "f1", onWork: () => undefined });

        assert.equal(firedBeforeTurn, true, "the Work must exist while the turn runs");
        const sessionId = (fake.calls[0]?.params as { sessionId: string }).sessionId;
        assert.deepEqual(hooks.fires[0], {
            jobId: "daily",
            fireId: "f1",
            title: "Daily digest",
            workspace: "/tmp/w",
            sessionId,
        });
        assert.deepEqual(hooks.settles, [
            { workId: "w-1", settle: { outcome: "completed", replyText: "all quiet" } },
        ]);
        assert.deepEqual(result, { workId: "w-1" });
    });

    it("tells the runner the Work id before the turn finishes", async () => {
        const hooks = new RecordingHooks();
        const seen: string[] = [];
        let atTurn: string[] = [];
        const fake = server((req) => {
            atTurn = [...seen];
            return ok(req, { sessionId: req.id, assistantMessage: reply("x") });
        });
        const dispatch = createJobDispatcher(() => fake, { work: hooks });
        await dispatch(job(), { fireId: "f1", onWork: (id) => seen.push(id) });
        assert.deepEqual(atTurn, ["w-1"]);
    });

    it("settles a failed turn as an error and still fails the fire", async () => {
        const hooks = new RecordingHooks();
        const fake = server(
            (req) =>
                ({
                    id: req.id,
                    ok: false,
                    error: { code: "model_unavailable", message: "no model" },
                }) as RpcResponse,
        );
        const dispatch = createJobDispatcher(() => fake, { work: hooks });
        await assert.rejects(dispatch(job(), { fireId: "f1", onWork: () => undefined }));
        assert.equal(hooks.settles[0]?.settle.outcome, "error");
        assert.match((hooks.settles[0]?.settle as { message: string }).message, /no model/);
    });

    it("waits for the queue to answer before calling a queued fire finished", async () => {
        const hooks = new RecordingHooks();
        const watch = new ManualWatch();
        const order: string[] = [];
        const fake = busyServer(watch, order);
        const dispatch = createJobDispatcher(() => fake, { work: hooks });
        const result = await dispatch(imJob(), { fireId: "f1", onWork: () => undefined });

        assert.deepEqual(result, { workId: "w-1" }, "the fire is accepted");
        assert.equal(order.indexOf("watch") < order.indexOf("prompt"), true);
        assert.equal(watch.waits.length, 1, "the entry is followed, not assumed");
        assert.equal(hooks.settles.length, 0, "enqueuing alone settles nothing");
        assert.equal(hooks.fires[0]?.sessionId, "im-session");

        watch.settle({ kind: "answered", message: reply("done at last") });
        await tick();
        assert.deepEqual(hooks.settles[0]?.settle, {
            outcome: "merged",
            replyText: "done at last",
        });
        assert.equal(watch.stopped, true);
    });

    it("records a queued prompt the user cleared as cancelled, never completed", async () => {
        const hooks = new RecordingHooks();
        const watch = new ManualWatch();
        const dispatch = createJobDispatcher(() => busyServer(watch, []), { work: hooks });
        await dispatch(imJob(), { fireId: "f1", onWork: () => undefined });
        watch.settle({ kind: "dropped" });
        await tick();
        assert.equal(hooks.settles[0]?.settle.outcome, "cancelled");
        assert.match(
            (hooks.settles[0]?.settle as { reason: string }).reason,
            /removed from the queue/,
        );
    });

    it("records a queued prompt stopped with its run as cancelled", async () => {
        const hooks = new RecordingHooks();
        const watch = new ManualWatch();
        const dispatch = createJobDispatcher(() => busyServer(watch, []), { work: hooks });
        await dispatch(imJob(), { fireId: "f1", onWork: () => undefined });
        watch.settle({ kind: "aborted" });
        await tick();
        assert.equal(hooks.settles[0]?.settle.outcome, "cancelled");
        assert.match(
            (hooks.settles[0]?.settle as { reason: string }).reason,
            /stopped with the run/,
        );
    });

    it("falls back to merged on a surface that cannot watch the queue", async () => {
        const hooks = new RecordingHooks();
        const dispatch = createJobDispatcher(() => busyServer(undefined, []), { work: hooks });
        await dispatch(imJob(), { fireId: "f1", onWork: () => undefined });
        assert.deepEqual(hooks.settles[0]?.settle, { outcome: "merged" });
    });

    it("records a prompt stopped by the user as cancelled, not failed", async () => {
        const hooks = new RecordingHooks();
        const fake = server(
            (req) =>
                ({
                    id: req.id,
                    ok: false,
                    error: { code: ErrorCodes.Aborted, message: "session.prompt aborted" },
                }) as RpcResponse,
        );
        const dispatch = createJobDispatcher(() => fake, { work: hooks });
        await assert.rejects(dispatch(job(), { fireId: "f1", onWork: () => undefined }));
        assert.equal(hooks.settles[0]?.settle.outcome, "cancelled");
        assert.match(
            (hooks.settles[0]?.settle as { reason: string }).reason,
            /stopped by the user/,
        );
    });

    it("gives two fires of one job two Works", async () => {
        const hooks = new RecordingHooks();
        const fake = server((req) => ok(req, { assistantMessage: reply("x") }));
        const dispatch = createJobDispatcher(() => fake, { work: hooks });
        const pinned = job({ sessionStrategy: "pin" });
        await dispatch(pinned, { fireId: "f1", onWork: () => undefined });
        await dispatch(pinned, { fireId: "f2", onWork: () => undefined });
        assert.deepEqual(
            hooks.fires.map((f) => f.fireId),
            ["f1", "f2"],
        );
        assert.equal(hooks.fires[0]?.sessionId, hooks.fires[1]?.sessionId);
    });

    it("does not track a built-in job", async () => {
        const hooks = new RecordingHooks();
        const dispatch = createJobDispatcher(() => server((req) => ok(req, {})), {
            work: hooks,
            builtinHandlers: new Map([["memory.dream", async () => ({ summary: "merged 3→1" })]]),
        });
        await dispatch(job({ builtin: true, command: "memory.dream", args: {} }), {
            fireId: "f1",
            onWork: () => undefined,
        });
        assert.equal(hooks.fires.length, 0);
    });
});

class MemoryStore {
    jobs = new Map<string, Job>();
    async list() {
        return [...this.jobs.values()];
    }
    async get(id: string) {
        return this.jobs.get(id) ?? null;
    }
    async save(j: Job) {
        this.jobs.set(j.id, structuredClone(j));
    }
    async mutate(id: string, update: (current: Job | null) => Job | null) {
        const next = update(this.jobs.get(id) ?? null);
        if (next) this.jobs.set(id, structuredClone(next));
        return next;
    }
    async delete(id: string) {
        this.jobs.delete(id);
    }
}

describe("runner records the fire's Work in history", () => {
    async function withTmp(fn: (dir: string) => Promise<void>) {
        const dir = await mkdtemp(join(tmpdir(), "taco-sched-work-"));
        try {
            await fn(dir);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    it("puts the workId on the finished entry and on runNow's result", async () => {
        await withTmp(async (dir) => {
            const store = new MemoryStore();
            store.jobs.set("daily", job({ enabled: false }));
            const scheduler = new Scheduler({
                store,
                lockDir: dir,
                invoke: async (_job, fire) => {
                    fire?.onWork("w-9");
                    return { workId: "w-9" };
                },
            });
            const result = await scheduler.runNow("daily");
            assert.deepEqual(result, { status: "ok", workId: "w-9" });
            const entry = store.jobs.get("daily")?.history[0];
            assert.equal(entry?.status, "ok");
            assert.equal(entry?.workId, "w-9");
        });
    });

    it("keeps the workId on a fire that timed out while its turn was still running", async () => {
        await withTmp(async (dir) => {
            const store = new MemoryStore();
            store.jobs.set("daily", job({ enabled: false }));
            let turnDone!: Promise<void>;
            const scheduler = new Scheduler({
                store,
                lockDir: dir,
                fireTimeoutMs: 20,
                invoke: async (_job, fire) => {
                    fire?.onWork("w-slow");
                    // A ref'd timer, unlike the runner's unref'd watchdog: it is
                    // what keeps the turn "still running" past the timeout.
                    turnDone = new Promise<void>((resolve) => setTimeout(resolve, 150));
                    await turnDone;
                    return { workId: "w-slow" };
                },
            });
            const result = await scheduler.runNow("daily");
            assert.equal(result.status, "failed");
            assert.equal(result.workId, "w-slow");
            const entry = store.jobs.get("daily")?.history[0];
            assert.equal(entry?.status, "err");
            assert.equal(entry?.workId, "w-slow", "the answer is in the Work, not lost");
            await turnDone;
        });
    });

    it("tags the finished entry, not a second row, when the Work arrives after the timeout", async () => {
        await withTmp(async (dir) => {
            const store = new MemoryStore();
            store.jobs.set("daily", job({ enabled: false }));
            let turnDone!: Promise<void>;
            const scheduler = new Scheduler({
                store,
                lockDir: dir,
                fireTimeoutMs: 20,
                invoke: async (_job, fire) => {
                    turnDone = (async () => {
                        // Recording the Work outlasts the fire's timeout.
                        await new Promise((r) => setTimeout(r, 80));
                        fire?.onWork("w-late");
                    })();
                    await turnDone;
                    return { workId: "w-late" };
                },
            });
            const result = await scheduler.runNow("daily");
            assert.equal(result.status, "failed");
            await turnDone;
            await new Promise((r) => setTimeout(r, 10));
            const history = store.jobs.get("daily")?.history ?? [];
            assert.equal(history.length, 1);
            assert.equal(history[0]?.status, "err");
            assert.equal(history[0]?.workId, "w-late");
        });
    });

    it("hands every fire a distinct fireId", async () => {
        await withTmp(async (dir) => {
            const store = new MemoryStore();
            store.jobs.set("daily", job({ enabled: false }));
            const ids: string[] = [];
            const scheduler = new Scheduler({
                store,
                lockDir: dir,
                invoke: async (_job, fire) => {
                    if (fire) ids.push(fire.fireId);
                    return undefined;
                },
            });
            await scheduler.runNow("daily");
            await scheduler.runNow("daily");
            assert.equal(ids.length, 2);
            assert.notEqual(ids[0], ids[1]);
        });
    });
});

it("parks a scheduled fire for user input instead of marking its question completed", async () => {
    const hooks = new RecordingHooks();
    const question = {
        role: "toolResult",
        toolCallId: "q",
        toolName: "planExit",
        isError: false,
        details: { waiting: true, questions: [{ question: "Approve?" }] },
    };
    const fake = server((req) => ok(req, { sessionId: req.id, assistantMessage: question }));
    await createJobDispatcher(() => fake, { work: hooks })(job(), {
        fireId: "ask",
        onWork: () => {},
    });
    const sessionId = hooks.fires[0]?.sessionId;
    assert.deepEqual(hooks.settles[0]?.settle, {
        outcome: "waiting",
        waiting: {
            toolCallId: "q",
            toolName: "planExit",
            sessionId,
            description: "Approve?",
        },
    });
});

it("parks a queued fire on its terminating question rather than reporting a merged completion", async () => {
    const hooks = new RecordingHooks();
    const watch = new ManualWatch();
    await createJobDispatcher(() => busyServer(watch, []), { work: hooks })(imJob(), {
        fireId: "ask",
        onWork: () => {},
    });
    watch.settle({
        kind: "answered",
        message: {
            role: "toolResult",
            toolCallId: "q",
            toolName: "askUser",
            isError: false,
            details: { waiting: true },
            content: [],
            timestamp: 1,
        },
    });
    await tick();
    assert.equal(hooks.settles[0]?.settle.outcome, "waiting");
});
