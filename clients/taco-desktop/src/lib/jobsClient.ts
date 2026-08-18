/**
 * Typed wrapper around the daemon's `jobs.*` RPC surface. The desktop
 * already has a generic `TacoClient.callProcess` that sends raw NDJSON
 * frames; this module adds the type-level wrapper so the Schedules UI
 * can call `client.jobs.list()` without re-declaring the params/result
 * shape at every call site.
 *
 * Jobs are process-scoped (the scheduler lives in the daemon process),
 * so every call goes through `callProcess`. `call()` would require the
 * sidecar to validate `params.workspace`, which the schedule UI never
 * sends.
 *
 * Every method takes an `Actor` so the daemon can enforce IM-scope vs
 * IDE-scope. The desktop constructs the actor from the active workspace
 * key (an `im://` workspace → IM triple; a real fs cwd → IDE workspace)
 * and closes over it at the call site. Tests / admin tooling can pass
 * `undefined` for legacy un-scoped access.
 */

import { JOBS_RPC } from "./jobsRpc.ts";
import type { TacoClient } from "./tacoClientTauri.ts";

/** Job shape — mirrors the sidecar's `Job` type. Kept here rather than
 *  imported from `@taco-ai/protocol` so PR4 doesn't widen that package. */
export interface Job {
    id: string;
    name: string;
    schedule: JobScheduleSpec;
    command: string;
    args: Record<string, unknown>;
    enabled: boolean;
    run_on_startup: boolean;
    last_run_at?: string;
    next_run_at?: string;
    history: JobHistoryEntry[];
    /** IM scope, server-derived. Desktop callers should not set these —
     *  the daemon derives them from `args.workspace` on create/update and
     *  ignores caller-supplied values (sandbox escape prevention). */
    channelId?: string;
    peerId?: string;
    /** Default `new`. `reuse` is only valid when `args.workspace` is `im://`. */
    sessionStrategy?: SessionStrategy;
    /** Set after the first fire of a `pin` job. */
    pinnedSessionId?: string;
}

export type SessionStrategy = "new" | "reuse" | "pin";

export type JobScheduleSpec =
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "interval"; ms: number };

export interface JobHistoryEntry {
    started_at: string;
    ended_at?: string;
    status: "running" | "ok" | "err";
    error?: string;
}

/** Mirrors the sidecar's `Actor` — kept here so the desktop doesn't import
 *  the scheduler module directly (different module graph). */
export type Actor =
    | { kind: "im"; channelId: string; peerId: string; chatId: string }
    | { kind: "ide"; workspace: string };

export interface JobsClient {
    list(actor?: Actor): Promise<Job[]>;
    get(id: string, actor?: Actor): Promise<Job | null>;
    create(job: Job, actor?: Actor): Promise<Job>;
    update(job: Job, actor?: Actor): Promise<Job>;
    delete(id: string, actor?: Actor): Promise<boolean>;
    runNow(id: string, actor?: Actor): Promise<boolean>;
    history(id: string, actor?: Actor): Promise<JobHistoryEntry[] | null>;
}

interface ListResult {
    jobs: Job[];
}
interface GetResult {
    job: Job | null;
}
interface CreateResult {
    job: Job;
}
interface UpdateResult {
    job: Job;
}
interface DeleteResult {
    deleted: boolean;
}
interface RunNowResult {
    ran: boolean;
}
interface HistoryResult {
    history: JobHistoryEntry[] | null;
}

export function createJobsClient(client: TacoClient): JobsClient {
    return {
        list: (actor) =>
            call<ListResult>(client, JOBS_RPC.list, {}, actor).then((r) => r.jobs ?? []),
        get: (id, actor) => call<GetResult>(client, JOBS_RPC.get, { id }, actor).then((r) => r.job),
        create: (job, actor) =>
            call<CreateResult>(client, JOBS_RPC.create, { job }, actor).then((r) => r.job),
        update: (job, actor) =>
            call<UpdateResult>(client, JOBS_RPC.update, { job }, actor).then((r) => r.job),
        delete: (id, actor) =>
            call<DeleteResult>(client, JOBS_RPC.delete, { id }, actor).then((r) => r.deleted),
        runNow: (id, actor) =>
            call<RunNowResult>(client, JOBS_RPC.runNow, { id }, actor).then((r) => r.ran),
        history: (id, actor) =>
            call<HistoryResult>(client, JOBS_RPC.history, { id }, actor).then((r) => r.history),
    };
}

/** Process-level RPC for jobs.* — the scheduler lives in the daemon process,
 *  not in any workspace. `callProcess` routes the frame through whichever
 *  workspace is currently started (the daemon's stdin is shared, so any
 *  started cwd works); `call()` would require `params.workspace` to be set
 *  on the sidecar side, which the jobs UI never provides. */
async function call<TResult>(
    client: TacoClient,
    method: string,
    params: Record<string, unknown>,
    actor: Actor | undefined,
): Promise<TResult> {
    return client.callProcess(method, actor === undefined ? params : { ...params, actor });
}
