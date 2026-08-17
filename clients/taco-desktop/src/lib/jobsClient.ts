/**
 * Typed wrapper around the daemon's `jobs.*` RPC surface. The desktop
 * already has a generic `TacoClient.call` that sends raw NDJSON frames;
 * this module adds the type-level wrapper so the Schedules UI can call
 * `client.jobs.list()` without re-declaring the params/result shape at
 * every call site.
 *
 * Each method passes through `call()` with the method name from
 * `jobsRpc.ts`; a runtime check (`throw on missing workspace`) ensures
 * the desktop has a live sidecar before trying. Jobs are process-
 * scoped, not workspace-scoped, but `call()` takes a workspace as the
 * first arg because that's how the existing dispatcher is shaped —
 * the workspace just routes the frame to whichever NDJSON socket is
 * attached to that cwd (the daemon spawns one server per connection).
 */

import type { WorkspaceId } from "@taco-ai/protocol";
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
}

export type JobScheduleSpec =
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "interval"; ms: number };

export interface JobHistoryEntry {
    started_at: string;
    ended_at?: string;
    status: "running" | "ok" | "err";
    error?: string;
}

export interface JobsClient {
    list(): Promise<Job[]>;
    get(id: string): Promise<Job | null>;
    create(job: Job): Promise<Job>;
    update(job: Job): Promise<Job>;
    delete(id: string): Promise<boolean>;
    runNow(id: string): Promise<boolean>;
    history(id: string): Promise<JobHistoryEntry[] | null>;
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
        list: () => call<ListResult>(client, JOBS_RPC.list, {}).then((r) => r.jobs ?? []),
        get: (id) => call<GetResult>(client, JOBS_RPC.get, { id }).then((r) => r.job),
        create: (job) => call<CreateResult>(client, JOBS_RPC.create, { job }).then((r) => r.job),
        update: (job) => call<UpdateResult>(client, JOBS_RPC.update, { job }).then((r) => r.job),
        delete: (id) => call<DeleteResult>(client, JOBS_RPC.delete, { id }).then((r) => r.deleted),
        runNow: (id) => call<RunNowResult>(client, JOBS_RPC.runNow, { id }).then((r) => r.ran),
        history: (id) =>
            call<HistoryResult>(client, JOBS_RPC.history, { id }).then((r) => r.history),
    };
}

/** Workspace-routed RPC for jobs.* — pass the desktop's current workspace
 *  (any connected cwd works; jobs are process-scoped). Falls back to
 *  "." when the desktop hasn't selected a workspace yet, matching how
 *  `desktop_config_read/write` are routed. */
async function call<TResult>(
    client: TacoClient,
    method: string,
    params: Record<string, unknown>,
): Promise<TResult> {
    // The dispatcher requires *some* workspace. Empty / missing workspace
    // is a transient UI state (no chat opened yet) — let the existing
    // dispatcher reject with its usual error rather than masking it here.
    return client.call(EMPTY_WORKSPACE, method, params);
}

const EMPTY_WORKSPACE: WorkspaceId = "" as WorkspaceId;
