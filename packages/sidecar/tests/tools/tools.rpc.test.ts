// Self-RPC tool tests: jobs.* dispatch and config tool wiring.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asSessionId, asWorkspaceId } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import { Value } from "typebox/value";
import type { Job } from "../../src/scheduler/types.ts";
import { createConfigTools, patchFields } from "../../src/tools/config.ts";
import type { TacoToolContext } from "../../src/tools/context.ts";
import {
    createJobsCreateTool,
    createJobsListTool,
    createJobsTools,
    createJobsUpdateTool,
    type JobsCreateInput,
} from "../../src/tools/jobs.ts";
import { invokeTool } from "../_helpers/invokeTool.ts";
import { sessionToolContext } from "../_helpers/toolContext.ts";

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
        workspace: asWorkspaceId("/tmp/ws"),
        call,
        actor: { kind: "ide", workspace: "/tmp/ws" },
        sessionId: asSessionId("test-session"),
        sessionKind: "main",
        isIm: false,
    };
}

function makeImCtx(records: CallRecord[]): TacoToolContext {
    const ctx = makeCtx(records);
    ctx.workspace = asWorkspaceId("im://ch1/u1/c1");
    ctx.actor = { kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" };
    return ctx;
}

function defaultStubResult(method: string): unknown {
    if (method === RPC.jobsList) return { jobs: [] };
    if (method === RPC.jobsGet) return { job: null };
    if (method === RPC.jobsCreate) return { job: { id: "" } };
    if (method === RPC.jobsUpdate) return { job: { id: "" } };
    if (method === RPC.jobsDelete) return { deleted: false };
    if (method === RPC.jobsRunNow) return { status: "skipped" };
    if (method === RPC.jobsHistory) return { history: null };
    return null;
}

describe("jobs tools — execute dispatches + closes actor", () => {
    it("jobsCreate dispatches to RPC.jobsCreate (IM, explicit reuse)", async () => {
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
        await invokeTool(tool, input, makeImCtx(records));
        assert.equal(records[0].method, RPC.jobsCreate);
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
        // (the model saw the wire error and supplied "/Users/someone"). The
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
        await invokeTool(tool, input, makeImCtx(records));
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
        await invokeTool(tool, input, makeCtx(records));
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
        await invokeTool(tool, input, makeImCtx(records));
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
        await invokeTool(tool, input, makeCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.sessionStrategy, "pin");
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
            () => invokeTool(tool, input, makeImCtx(records)),
            /channel jobs only support sessionStrategy="reuse"/,
        );
        assert.equal(records.length, 0);
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
        await invokeTool(tool, input, makeCtx(records));
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
        await invokeTool(tool, input, makeImCtx(records));
        const params = records[0].params as { job: Job };
        assert.equal(params.job.sessionStrategy, "reuse");

        // IDE: defaults to pin, rejects explicit reuse
        await assert.rejects(
            () =>
                invokeTool(
                    tool,
                    {
                        ...input,
                        job: { ...input.job, sessionStrategy: "reuse" },
                    } as unknown as JobsCreateInput,
                    makeCtx(records),
                ),
            /reuse strategy requires a channel workspace/,
        );
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
                invokeTool(tool, {}, {
                    env: undefined as never,
                    workspace: asWorkspaceId("/tmp/ws"),
                    sessionId: asSessionId("test-session"),
                    sessionKind: "main",
                    isIm: false,
                } as TacoToolContext),
            /no self-RPC dispatcher/,
        );
    });
});

describe("jobs tools — list rendering", () => {
    it("renders an empty list as 'no jobs'", async () => {
        const records: CallRecord[] = [];
        const tool = createJobsListTool();
        const result = await invokeTool(tool, {}, makeCtx(records));
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
            workspace: asWorkspaceId("/tmp/ws"),
            call: async <P, R>(_method: string, _workspace: string, _params: P): Promise<R> => {
                return stubResult as R;
            },
            actor: { kind: "ide", workspace: "/tmp/ws" },
            sessionId: asSessionId("test-session"),
            sessionKind: "main",
            isIm: false,
        };
        const tool = createJobsListTool();
        const result = await invokeTool(tool, {}, ctx);
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
            workspace: asWorkspaceId("/tmp/ws"),
            call: async <_P, R>(): Promise<R> => stubResult as R,
            actor,
            sessionId: asSessionId("test-session"),
            sessionKind: "main",
            isIm: false,
        });
        const tool = createJobsListTool();
        const imResult = await invokeTool(
            tool,
            {},
            makeCtxWithActor({ kind: "im", channelId: "ch1", peerId: "u1", chatId: "c1" }),
        );
        const ideResult = await invokeTool(
            tool,
            {},
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
    it("requires an id for update but not create", () => {
        const input = {
            job: {
                name: "x",
                schedule: { kind: "interval", ms: 60_000 },
                command: "agent.invoke",
                args: { prompt: "hello" },
                enabled: true,
                run_on_startup: false,
            },
        };
        assert.equal(Value.Check(createJobsCreateTool().parameters, input), true);
        assert.equal(Value.Check(createJobsUpdateTool().parameters, input), false);
        assert.equal(
            Value.Check(createJobsUpdateTool().parameters, {
                job: { ...input.job, id: "job-1" },
            }),
            true,
        );
    });
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

function makeConfigCtx(calls: { method: string; params: unknown }[] = []) {
    return sessionToolContext({
        call: async <P, R>(method: string, _workspace: string, params: P): Promise<R> => {
            calls.push({ method, params: params as unknown });
            if (method === "settings.get") {
                return {
                    global: {
                        defaultModel: "claude-opus-5",
                        anthropicApiKey: { configured: true },
                    },
                } as R;
            }
            return { approved: true, fields: [], global: { defaultModel: "claude-opus-5" } } as R;
        },
    });
}

describe("config tools", () => {
    describe("configGet", () => {
        it("returns the masked config through settings.get", async () => {
            const calls: { method: string; params: unknown }[] = [];
            const { configGet } = createConfigTools();
            const result = await invokeTool(configGet, {}, makeConfigCtx(calls));
            assert.equal(calls[0]?.method, "settings.get");
            const text = (result.content[0] as { text: string }).text;
            // The masked view is what comes back — a configured key shows as
            // present, never as its value.
            assert.match(text, /defaultModel/);
        });

        it("refuses an IM session", async () => {
            const { configGet } = createConfigTools();
            const ctx = sessionToolContext({ isIm: true });
            await assert.rejects(
                () => invokeTool(configGet, {}, ctx),
                /not available in this session/,
            );
        });

        it("refuses a subagent", async () => {
            const { configGet } = createConfigTools();
            const ctx = sessionToolContext({ sessionKind: "subagent" });
            await assert.rejects(
                () => invokeTool(configGet, {}, ctx),
                /not available in this session/,
            );
        });
    });

    describe("configPatch", () => {
        it("routes the change through config.patch so the server can approve it", async () => {
            const calls: { method: string; params: unknown }[] = [];
            const { configPatch } = createConfigTools();
            await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                makeConfigCtx(calls),
            );
            assert.equal(calls[0]?.method, "config.patch");
            const params = calls[0]?.params as {
                workspace: string;
                sessionId: string;
                toolCallId: string;
                patch: Record<string, unknown>;
            };
            // The approval prompt needs the session and the tool call to land
            // on the right card.
            assert.equal(params.sessionId, asSessionId("test-session"));
            assert.equal(params.toolCallId, "tc-1");
            assert.deepEqual(params.patch, { defaultModel: "claude-opus-5" });
        });

        it("reports a declined change without writing", async () => {
            const calls: { method: string; params: unknown }[] = [];
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({
                call: async <P, R>(method: string, _workspace: string, params: P): Promise<R> => {
                    calls.push({ method, params: params as unknown });
                    return {
                        approved: false,
                        fields: ["defaultModel"],
                        denialReason: "user_denied",
                    } as R;
                },
            });
            const result = await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                ctx,
            );
            const text = (result.content[0] as { text: string }).text;
            assert.match(text, /user denied/);
            assert.equal((result.details as { approved: boolean }).approved, false);
        });

        it("tells the model a user denial is final — no retry, no workaround", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({
                call: async <R>(): Promise<R> =>
                    ({
                        approved: false,
                        fields: ["defaultModel"],
                        denialReason: "user_denied",
                    }) as R,
            });
            const result = await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                ctx,
            );
            const text = (result.content[0] as { text: string }).text;
            assert.match(text, /user denied/);
            // The point of the message: a denial is about the intent, so a
            // smaller or differently-shaped attempt is still the denied action.
            assert.match(text, /Do not retry/);
            assert.match(text, /another route/);
            // Marked as an error so the model treats it as a failed action.
            assert.equal((result as { isError?: boolean }).isError, true);
        });

        it("distinguishes a timeout from a user denial", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({
                call: async <R>(): Promise<R> =>
                    ({
                        approved: false,
                        fields: ["defaultModel"],
                        denialReason: "timeout",
                    }) as R,
            });
            const result = await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                ctx,
            );
            const text = (result.content[0] as { text: string }).text;
            assert.match(text, /timed out/);
            // A timeout is nobody having answered, so asking is still fine.
            assert.doesNotMatch(text, /The user denied/);
        });

        it("tells the model not to work around a missing approver", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({
                call: async <R>(): Promise<R> =>
                    ({
                        approved: false,
                        fields: ["defaultModel"],
                        denialReason: "no_approver",
                    }) as R,
            });
            const result = await invokeTool(
                configPatch,
                { patch: { defaultModel: "claude-opus-5" } },
                ctx,
            );
            const text = (result.content[0] as { text: string }).text;
            assert.match(text, /no desktop app is connected/);
            assert.match(text, /Do not retry it or work around it/);
        });

        it("refuses an IM session", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({ isIm: true });
            await assert.rejects(
                () => invokeTool(configPatch, { patch: { defaultModel: "x" } }, ctx),
                /not available in this session/,
            );
        });

        it("refuses a subagent", async () => {
            const { configPatch } = createConfigTools();
            const ctx = sessionToolContext({ sessionKind: "subagent" });
            await assert.rejects(
                () => invokeTool(configPatch, { patch: { defaultModel: "x" } }, ctx),
                /not available in this session/,
            );
        });
    });

    describe("patchFields", () => {
        it("lists only the fields the patch sets", () => {
            assert.deepEqual(
                patchFields({ defaultModel: "x", thinkingLevel: undefined } as never),
                ["defaultModel"],
            );
        });
    });
});
