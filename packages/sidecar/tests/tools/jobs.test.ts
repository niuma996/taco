/**
 * jobs.* model tool tests — exercise the self-RPC wiring.
 *
 * Each tool must:
 *  - dispatch to the matching `jobs.*` RPC method,
 *  - close the actor (IM triple or IDE workspace) over the params via the
 *    `TacoToolContext` the harness injects into every `execute`,
 *  - render the response as plain text.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Value } from "typebox/value";
import { JOBS_RPC } from "../../src/scheduler/jobsRpc.ts";
import type { Job } from "../../src/scheduler/types.ts";
import type { TacoToolContext } from "../../src/tools/context.ts";
import {
    createJobsCreateTool,
    createJobsDeleteTool,
    createJobsGetTool,
    createJobsListTool,
    createJobsRunNowTool,
    createJobsTools,
    createJobsUpdateTool,
    type JobsCreateInput,
    type JobsDeleteInput,
    type JobsGetInput,
    type JobsRunNowInput,
} from "../../src/tools/jobs.ts";

interface CallRecord {
    method: string;
    workspace: string;
    params: Record<string, unknown>;
}

function makeCtx(records: CallRecord[]): TacoToolContext {
    const call = async <P, R>(method: string, workspace: string, params: P): Promise<R> => {
        records.push({ method, workspace, params: params as Record<string, unknown> });
        // Stub result with the shape each RPC returns so `render` doesn't
        // crash; tests that care about specific values capture `records`.
        return defaultStubResult(method) as R;
    };
    return {
        env: undefined as never,
        workspace: "/tmp/ws",
        call,
        actor: { kind: "ide", workspace: "/tmp/ws" },
    };
}

function makeImCtx(records: CallRecord[]): TacoToolContext {
    const ctx = makeCtx(records);
    ctx.workspace = "im://ch1/u1/c1";
    ctx.actor = { kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" };
    return ctx;
}

function defaultStubResult(method: string): unknown {
    if (method === JOBS_RPC.list) return { jobs: [] };
    if (method === JOBS_RPC.get) return { job: null };
    if (method === JOBS_RPC.create) return { job: { id: "" } };
    if (method === JOBS_RPC.update) return { job: { id: "" } };
    if (method === JOBS_RPC.delete) return { deleted: false };
    if (method === JOBS_RPC.runNow) return { ran: false };
    if (method === JOBS_RPC.history) return { history: null };
    return null;
}

describe("jobs tools — execute dispatches + closes actor", () => {
    it("jobsList calls JOBS_RPC.list and closes actor", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsListTool();
        const ctx = makeImCtx(records);
        await tool.execute("tc-1", {}, undefined, undefined, ctx);
        assert.equal(records.length, 1);
        assert.equal(records[0].method, JOBS_RPC.list);
        assert.equal(records[0].workspace, "im://ch1/u1/c1");
        assert.deepEqual(records[0].params, {
            actor: { kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" },
        });
    });

    it("jobsGet calls JOBS_RPC.get with id", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsGetTool();
        const input: JobsGetInput = { id: "nightly" };
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        assert.equal(records.length, 1);
        assert.equal(records[0].method, JOBS_RPC.get);
        assert.deepEqual(records[0].params, {
            id: "nightly",
            actor: { kind: "ide", workspace: "/tmp/ws" },
        });
    });

    it("jobsCreate dispatches to JOBS_RPC.create (IM, explicit reuse)", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "morning-brief",
                name: "Morning Brief",
                schedule: { kind: "cron", expr: "0 9 * * *" },
                command: "agent.invoke",
                args: { prompt: "summarize" },
                enabled: true,
                run_on_startup: false,
                sessionStrategy: "reuse",
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeImCtx(records));
        assert.equal(records[0].method, JOBS_RPC.create);
        const params = records[0].params as { job: Job; actor: unknown };
        assert.equal(params.job.id, "morning-brief");
        assert.equal(params.job.sessionStrategy, "reuse");
        // Critical: args.workspace is injected from ctx.workspace (the im:// URL
        // for IM sessions), NOT from anything the model passed. This is what
        // makes the model-side schema permissive while the wire-side
        // assertJob still gets a non-empty workspace.
        assert.equal(params.job.args.workspace, "im://ch1/u1/c1");
        assert.deepEqual(params.actor, {
            kind: "im",
            channelId: "ch1",
            peerId: "u1",
            chatId: "c1",
        });
    });

    it("jobsCreate overwrites a caller-supplied args.workspace with ctx.workspace", async () => {
        // Defense against the LLM-fills-args.workspace-by-guess failure mode
        // (the model saw the wire error and supplied "/Users/lewis"). The
        // tool layer is the trusted boundary — anything the model passes
        // for args.workspace is discarded.
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "x",
                name: "X",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { workspace: "/some/other/path", prompt: "y" },
                enabled: true,
                run_on_startup: false,
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeImCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.args.workspace, "im://ch1/u1/c1");
    });

    it("jobsCreate injects args.workspace from ctx for IDE sessions", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "x",
                name: "X",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "y" },
                enabled: true,
                run_on_startup: false,
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.args.workspace, "/tmp/ws");
    });

    it("jobsCreate fills default 'reuse' for IM when sessionStrategy is omitted", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "morning-brief",
                name: "Morning Brief",
                schedule: { kind: "cron", expr: "0 9 * * *" },
                command: "agent.invoke",
                args: { prompt: "summarize" },
                enabled: true,
                run_on_startup: false,
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeImCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.sessionStrategy, "reuse");
    });

    it("jobsCreate fills default 'pin' for IDE when sessionStrategy is omitted", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "nightly-cleanup",
                name: "Nightly cleanup",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "tidy up" },
                enabled: true,
                run_on_startup: false,
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.sessionStrategy, "pin");
    });

    it("jobsCreate allows 'reuse' on IM sessions", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "bad",
                name: "Bad",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
                sessionStrategy: "reuse",
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeImCtx(records));
        assert.equal((records[0].params as { job: Job }).job.sessionStrategy, "reuse");
    });

    it("jobsCreate rejects 'new' on IM sessions (must reuse)", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "bad",
                name: "Bad",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
                sessionStrategy: "new",
            },
        } as unknown as JobsCreateInput;
        await assert.rejects(
            () => tool.execute("tc-1", input, undefined, undefined, makeImCtx(records)),
            /channel jobs only support sessionStrategy="reuse"/,
        );
        assert.equal(records.length, 0);
    });

    it("jobsCreate allows 'pin' on IDE sessions", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "bad",
                name: "Bad",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
                sessionStrategy: "pin",
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        assert.equal((records[0].params as { job: Job }).job.sessionStrategy, "pin");
    });

    it("jobsCreate allows explicit 'new' on IDE sessions", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsCreateTool();
        const input = {
            job: {
                id: "bad",
                name: "Bad",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
                sessionStrategy: "new",
            },
        } as unknown as JobsCreateInput;
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        assert.equal((records[0].params as { job: Job }).job.sessionStrategy, "new");
    });

    it("jobsUpdate also fills actor-aware defaults and rejects mismatches", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsUpdateTool();
        const input = {
            job: {
                id: "x",
                name: "X",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
            },
        } as unknown as JobsCreateInput;
        // IM: defaults to reuse
        await tool.execute("tc-1", input, undefined, undefined, makeImCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.sessionStrategy, "reuse");

        // IDE: defaults to pin, rejects explicit reuse
        await assert.rejects(
            () =>
                tool.execute(
                    "tc-1",
                    {
                        ...input,
                        job: { ...input.job, sessionStrategy: "reuse" },
                    } as unknown as JobsCreateInput,
                    undefined,
                    undefined,
                    makeCtx(records),
                ),
            /reuse strategy requires a channel workspace/,
        );
    });

    it("jobsUpdate calls JOBS_RPC.update", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsUpdateTool();
        const input: JobsCreateInput = {
            job: {
                id: "a",
                name: "A",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: false,
                run_on_startup: false,
            },
        };
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        assert.equal(records[0].method, JOBS_RPC.update);
    });

    it("jobsDelete calls JOBS_RPC.delete", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsDeleteTool();
        const input: JobsDeleteInput = { id: "stale" };
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        assert.equal(records[0].method, JOBS_RPC.delete);
        assert.deepEqual(records[0].params, {
            id: "stale",
            actor: { kind: "ide", workspace: "/tmp/ws" },
        });
    });

    it("jobsRunNow calls JOBS_RPC.runNow", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsRunNowTool();
        const input: JobsRunNowInput = { id: "fire-now" };
        await tool.execute("tc-1", input, undefined, undefined, makeCtx(records));
        assert.equal(records[0].method, JOBS_RPC.runNow);
    });

    it("createJobsTools returns all six tools in stable order", () => {
        const tools = createJobsTools();
        assert.deepEqual(
            tools.map((t) => t.name),
            ["jobsList", "jobsGet", "jobsCreate", "jobsUpdate", "jobsDelete", "jobsRunNow"],
        );
    });

    it("jobs tools throw clearly when ctx.call is missing", async () => {
        const tool = createJobsListTool();
        await assert.rejects(
            () =>
                tool.execute("tc-1", {}, undefined, undefined, {
                    env: undefined as never,
                    workspace: "/tmp/ws",
                } as TacoToolContext),
            /no self-RPC dispatcher/,
        );
    });
});

describe("jobs tools — list rendering", () => {
    it("renders an empty list as 'no jobs'", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsListTool();
        const result = await tool.execute("tc-1", {}, undefined, undefined, makeCtx(records));
        assert.equal((result.content[0] as { text: string }).text, "no jobs");
    });

    it("renders schedule + strategy per row", async () => {
        const stubResult: unknown = {
            jobs: [
                {
                    id: "a",
                    name: "A",
                    schedule: { kind: "interval", ms: 60_000 },
                    command: "agent.invoke",
                    args: { prompt: "x" },
                    enabled: true,
                    run_on_startup: false,
                    history: [],
                    sessionStrategy: "reuse",
                } satisfies Job,
            ],
        };
        const ctx: TacoToolContext = {
            env: undefined as never,
            workspace: "/tmp/ws",
            call: async <P, R>(_method: string, _workspace: string, _params: P): Promise<R> => {
                return stubResult as R;
            },
            actor: { kind: "ide", workspace: "/tmp/ws" },
        };
        const tool = createJobsListTool();
        const result = await tool.execute("tc-1", {}, undefined, undefined, ctx);
        const text = (result.content[0] as { text: string }).text;
        assert.ok(text.includes("a (enabled"), `expected enabled marker in ${text}`);
        assert.ok(text.includes("every 60000ms"), `expected schedule in ${text}`);
        assert.ok(text.includes("strategy=reuse"), `expected strategy in ${text}`);
    });

    it("uses actor-aware default for jobs whose sessionStrategy is unset", async () => {
        // Job stored without sessionStrategy — the listing should resolve the
        // default for the actor so the LLM never sees "new" on its own scope.
        const stubResult: unknown = {
            jobs: [
                {
                    id: "a",
                    name: "A",
                    schedule: { kind: "interval", ms: 60_000 },
                    command: "agent.invoke",
                    args: { prompt: "x" },
                    enabled: true,
                    run_on_startup: false,
                    history: [],
                } satisfies Job,
            ],
        };
        const makeCtxWithActor = (actor: TacoToolContext["actor"]): TacoToolContext => ({
            env: undefined as never,
            workspace: "/tmp/ws",
            call: async <_P, R>(): Promise<R> => stubResult as R,
            actor,
        });
        const tool = createJobsListTool();
        const imResult = await tool.execute(
            "tc-1",
            {},
            undefined,
            undefined,
            makeCtxWithActor({ kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" }),
        );
        const ideResult = await tool.execute(
            "tc-1",
            {},
            undefined,
            undefined,
            makeCtxWithActor({ kind: "ide", workspace: "/tmp/ws" }),
        );
        assert.ok(
            (imResult.content[0] as { text: string }).text.includes("strategy=reuse"),
            "IM scope should default to reuse",
        );
        assert.ok(
            (ideResult.content[0] as { text: string }).text.includes("strategy=pin"),
            "IDE scope should default to pin",
        );
    });
});

describe("jobs tools — schema validation", () => {
    it("rejects job id with traversal characters", () => {
        const tool = createJobsCreateTool();
        const bad: JobsCreateInput = {
            job: {
                id: "../escape",
                name: "x",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
            },
        };
        assert.equal(Value.Check(tool.parameters, bad), false);
    });

    it("rejects unknown sessionStrategy values", () => {
        const tool = createJobsCreateTool();
        const bad = {
            job: {
                id: "ok",
                name: "x",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "x" },
                enabled: true,
                run_on_startup: false,
                sessionStrategy: "yolo",
            },
        };
        assert.equal(Value.Check(tool.parameters, bad), false);
    });

    it("accepts the three valid sessionStrategy values", () => {
        const tool = createJobsCreateTool();
        for (const s of ["new", "reuse", "pin"] as const) {
            const ok: JobsCreateInput = {
                job: {
                    id: "ok",
                    name: "x",
                    schedule: { kind: "interval", ms: 60_000 },
                    command: "agent.invoke",
                    args: { prompt: "x" },
                    enabled: true,
                    run_on_startup: false,
                    sessionStrategy: s,
                },
            };
            assert.equal(Value.Check(tool.parameters, ok), true, `strategy ${s} should be valid`);
        }
    });

    it("accepts jobs without args.workspace (filled in by runtime)", () => {
        // The model no longer carries workspace inside `args` — the runtime
        // fills it from TacoToolContext.workspace. The tool schema must
        // accept jobs whose args omit it (the desktop UI / scripts
        // continue to pass it directly, server-side assertJob still
        // requires it on the wire).
        const tool = createJobsCreateTool();
        const ok: JobsCreateInput = {
            job: {
                id: "ok",
                name: "x",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "hello" },
                enabled: true,
                run_on_startup: false,
            },
        };
        assert.equal(Value.Check(tool.parameters, ok), true);
    });
});
