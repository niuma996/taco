/**
 * jobs.* model tools — let the LLM manage its own scheduled jobs.
 *
 * Each tool is a thin self-RPC wrapper around the matching `jobs.*` RPC. The
 * harness injects the workspace + actor + call via `toolContext` (see
 * `tools/context.ts`); the schema only carries business fields, so the model
 * never has to know about the scope rule — the server enforces it once and
 * the tool just fills in the actor from context.
 *
 * Six tools (list / get / create / update / delete / runNow). `history`
 * deliberately has no tool counterpart: the model rarely needs past runs
 * during a session, and the UI surfaces history alongside the job list.
 *
 * See `memory.ts` for the same self-RPC pattern.
 */

import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import { JOBS_RPC } from "../scheduler/jobsRpc.ts";
import type { Job, SessionStrategy } from "../scheduler/types.ts";
import type { TacoToolContext } from "./context.ts";

// ─── schema ──────────────────────────────────────────────────────────────────

const sessionStrategySchema = Type.Union([
    Type.Literal("new"),
    Type.Literal("reuse"),
    Type.Literal("pin"),
]);

const scheduleSchema = Type.Union([
    Type.Object({
        kind: Type.Literal("cron"),
        expr: Type.String({ minLength: 1 }),
        tz: Type.Optional(Type.String()),
    }),
    Type.Object({
        kind: Type.Literal("interval"),
        ms: Type.Integer({ minimum: 1 }),
    }),
]);

const jobSchema = Type.Object({
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" })),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    schedule: scheduleSchema,
    // The scheduler dispatcher only routes `agent.invoke` to a fresh agent
    // session — every fire spins up the agent with this command's `args.prompt`
    // as the initial user message. Any shell-style command you want to run
    // (e.g. `mmx search ...`) belongs in `args.prompt`; the agent will pick
    // the right tool from its catalog and route it through the workspace's
    // permission policy. Pinning a shell command into `command` would only
    // re-route through the agent again, so the tool whitelists `agent.invoke`
    // to set that expectation up front.
    command: Type.Literal("agent.invoke"),
    // `workspace` (the job's runtime cwd) is filled in by the runtime from
    // toolContext — the model never specifies it. For IM sessions this is
    // the im:// URL; for IDE sessions it's the session cwd. Server-side
    // `assertJob` still requires the field on the wire (desktop UI / scripts
    // bypass the tool layer) and fills it in from the actor if missing.
    args: Type.Object(
        {
            prompt: Type.String({
                minLength: 1,
                description:
                    "Required prompt the agent receives on every fire. " +
                    "Use plain language describing the task; embed any shell-style " +
                    'calls (e.g. `mmx search query --q "..."`) and the agent will ' +
                    "route them through the appropriate tool.",
            }),
        },
        {
            additionalProperties: true,
            description:
                "Free-form argument bag passed verbatim to `agent.invoke`. `workspace` is filled in by the runtime from the session cwd.",
        },
    ),
    enabled: Type.Boolean(),
    run_on_startup: Type.Boolean(),
    sessionStrategy: Type.Optional(sessionStrategySchema),
    pinnedSessionId: Type.Optional(Type.String()),
});

const jobsListSchema = Type.Object({});

const jobsGetSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
});

const jobsCreateSchema = Type.Object({
    job: jobSchema,
});

const jobsUpdateSchema = Type.Object({
    job: jobSchema,
});

const jobsDeleteSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
});

const jobsRunNowSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" }),
});

export type JobsListInput = Static<typeof jobsListSchema>;
export type JobsGetInput = Static<typeof jobsGetSchema>;
export type JobsCreateInput = Static<typeof jobsCreateSchema>;
export type JobsUpdateInput = Static<typeof jobsUpdateSchema>;
export type JobsDeleteInput = Static<typeof jobsDeleteSchema>;
export type JobsRunNowInput = Static<typeof jobsRunNowSchema>;

// ─── shared tool builder ─────────────────────────────────────────────────────

interface JobsToolOptions<TInput, TResult> {
    name: string;
    label: string;
    summary: string;
    mutates: boolean;
    schema: import("typebox").TSchema;
    rpcMethod: string;
    buildParams: (input: TInput, ctx: TacoToolContext) => Record<string, unknown>;
    render: (input: TInput, result: TResult, ctx: TacoToolContext) => string;
}

function buildJobsTool<TInput, TResult>(
    opts: JobsToolOptions<TInput, TResult>,
): AgentHarnessTool<TacoToolContext> {
    return {
        name: opts.name,
        label: opts.label,
        description: `${opts.summary}\n\nBacked by ${opts.rpcMethod}.`,
        parameters: opts.schema as unknown as AgentHarnessTool<TacoToolContext>["parameters"],
        executionMode: "sequential",
        taco: {
            promptSummary: opts.summary,
            mutates: opts.mutates,
        },
        async execute(
            _toolCallId: string,
            input: TInput,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown | undefined,
            ctx: TacoToolContext,
        ): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
            const { workspace, actor, call } = ctx;
            if (!call) {
                throw new Error(`${opts.rpcMethod}: no self-RPC dispatcher in this workspace`);
            }
            const params = opts.buildParams(input, ctx);
            const result = await call<Record<string, unknown>, TResult>(opts.rpcMethod, workspace, {
                ...params,
                actor,
            });
            return {
                content: [{ type: "text", text: opts.render(input, result, ctx) }],
                details: result,
            };
        },
    };
}

// ─── six tools ───────────────────────────────────────────────────────────────

export function createJobsListTool(): AgentHarnessTool<TacoToolContext> {
    return buildJobsTool<JobsListInput, { jobs: Job[] }>({
        name: "jobsList",
        label: "jobs.list",
        summary:
            "List every scheduled job visible to the current session — IM jobs filtered to the current channel/peer, IDE jobs to the current workspace. Use before create/update to discover existing ids and avoid collisions.",
        mutates: false,
        schema: jobsListSchema,
        rpcMethod: JOBS_RPC.list,
        buildParams: () => ({}),
        render: (_input, result, ctx) => {
            if (result.jobs.length === 0) return "no jobs";
            return result.jobs
                .map((j) => {
                    const schedule = formatSchedule(j);
                    // Use the actor-aware default so the listing matches what
                    // `jobsCreate`/`jobsUpdate` will fill in for an unset
                    // sessionStrategy — the LLM should never see "new" on
                    // its own scope's default.
                    const strategy = j.sessionStrategy ?? defaultStrategyFor(ctx);
                    return `${j.id} (${j.enabled ? "enabled" : "disabled"}, ${schedule}, strategy=${strategy})`;
                })
                .join("\n");
        },
    });
}

export function createJobsGetTool(): AgentHarnessTool<TacoToolContext> {
    return buildJobsTool<JobsGetInput, { job: Job | null }>({
        name: "jobsGet",
        label: "jobs.get",
        summary:
            "Read one scheduled job by id — returns the full record (schedule, args, history last entry). Use when the list summary is too terse to decide the next action.",
        mutates: false,
        schema: jobsGetSchema,
        rpcMethod: JOBS_RPC.get,
        buildParams: (input) => ({ id: input.id }),
        render: (_input, result, _ctx) =>
            result.job ? JSON.stringify(result.job, null, 2) : "not found",
    });
}

export function createJobsCreateTool(): AgentHarnessTool<TacoToolContext> {
    return buildJobsTool<JobsCreateInput, { job: Job }>({
        name: "jobsCreate",
        label: "jobs.create",
        summary:
            "Create a new scheduled job in this session's scope. The daemon generates the globally unique id. Channel sessions default to reuse the current conversation; non-channel sessions default to pin a dedicated session and may explicitly choose new.",
        mutates: true,
        schema: jobsCreateSchema,
        rpcMethod: JOBS_RPC.create,
        buildParams: (input, ctx) => ({
            job: {
                ...input.job,
                // Inject `args.workspace` from the runtime. The schema no longer
                // requires the model to pass it (and an IM session would not
                // know the im:// URL), but server-side `assertJob` still
                // requires it on the wire — the tool layer is the trusted
                // boundary that fills it in. Any value the model sends is
                // overwritten; we don't trust caller-supplied scope fields.
                args: {
                    ...input.job.args,
                    workspace: ctx.workspace,
                },
                sessionStrategy: resolveSessionStrategy(input.job.sessionStrategy, ctx, "create"),
            },
        }),
        render: (_input, result, _ctx) => `created ${result.job.id}`,
    });
}

export function createJobsUpdateTool(): AgentHarnessTool<TacoToolContext> {
    return buildJobsTool<JobsUpdateInput, { job: Job }>({
        name: "jobsUpdate",
        label: "jobs.update",
        summary:
            "Replace an existing scheduled job by id. The scope cannot be changed. Channel jobs only use reuse; non-channel jobs default to pin and may explicitly choose new.",
        mutates: true,
        schema: jobsUpdateSchema,
        rpcMethod: JOBS_RPC.update,
        buildParams: (input, ctx) => ({
            job: {
                ...input.job,
                args: {
                    ...input.job.args,
                    workspace: ctx.workspace,
                },
                sessionStrategy: resolveSessionStrategy(input.job.sessionStrategy, ctx, "update"),
            },
        }),
        render: (_input, result, _ctx) => `updated ${result.job.id}`,
    });
}

export function createJobsDeleteTool(): AgentHarnessTool<TacoToolContext> {
    return buildJobsTool<JobsDeleteInput, { deleted: boolean }>({
        name: "jobsDelete",
        label: "jobs.delete",
        summary:
            "Remove a scheduled job by id. The daemon also drops its in-flight lock file, so any currently running fire finishes naturally without leaking state.",
        mutates: true,
        schema: jobsDeleteSchema,
        rpcMethod: JOBS_RPC.delete,
        buildParams: (input) => ({ id: input.id }),
        render: (input, result, _ctx) => `${result.deleted ? "deleted" : "not found"} ${input.id}`,
    });
}

export function createJobsRunNowTool(): AgentHarnessTool<TacoToolContext> {
    return buildJobsTool<JobsRunNowInput, { ran: boolean }>({
        name: "jobsRunNow",
        label: "jobs.run_now",
        summary:
            "Force-fire a job immediately, outside its schedule. Returns ran=true if the fire actually started, ran=false if an existing fire holds the lock (the new fire is dropped, not queued).",
        mutates: true,
        schema: jobsRunNowSchema,
        rpcMethod: JOBS_RPC.runNow,
        buildParams: (input) => ({ id: input.id }),
        render: (input, result, _ctx) => `${result.ran ? "fired" : "busy"} ${input.id}`,
    });
}

/** Single barrel so workspace.ts can push all six with one call. */
export function createJobsTools(): AgentHarnessTool<TacoToolContext>[] {
    return [
        createJobsListTool(),
        createJobsGetTool(),
        createJobsCreateTool(),
        createJobsUpdateTool(),
        createJobsDeleteTool(),
        createJobsRunNowTool(),
    ];
}

// ─── helpers (internal) ──────────────────────────────────────────────────────

function formatSchedule(job: Job): string {
    if (job.schedule.kind === "cron") {
        return job.schedule.tz
            ? `cron(${job.schedule.expr} ${job.schedule.tz})`
            : `cron(${job.schedule.expr})`;
    }
    return `every ${job.schedule.ms}ms`;
}

/** Default `sessionStrategy` per actor kind:
-   - IM (channelId/peerId triple): `"reuse"` — every fire continues the
-     current channel conversation.
-   - IDE (fs workspace): `"pin"` — every fire reuses the job's dedicated
-     session; callers may explicitly choose `"new"` instead.
-   - undefined actor (admin / tests): `"pin"`.
-   The schema intentionally still lists `"new` / `"reuse` / `"pin` so the
-   model sees one vocabulary; the tool fills in the right default and
-   rejects mismatches with a clear message instead of silently falling
-   back. The dispatcher (`scheduler/dispatcher.ts`) enforces the same
-   rule server-side; the tool layer rejects earlier so the LLM never
-   has to round-trip a request that's known to fail. */
function defaultStrategyFor(ctx: TacoToolContext): SessionStrategy {
    if (!ctx.actor) return "pin";
    return ctx.actor.kind === "im" ? "reuse" : "pin";
}

function resolveSessionStrategy(
    raw: SessionStrategy | undefined,
    ctx: TacoToolContext,
    verb: "create" | "update",
): SessionStrategy {
    const { actor } = ctx;
    if (!actor) {
        return raw ?? "pin";
    }
    if (actor.kind === "im") {
        if (raw === undefined || raw === "reuse") return "reuse";
        throw new Error(`jobs.${verb}: channel jobs only support sessionStrategy="reuse"`);
    }
    if (raw === undefined || raw === "pin" || raw === "new") return raw ?? "pin";
    throw new Error(`jobs.${verb}: reuse strategy requires a channel workspace`);
}
