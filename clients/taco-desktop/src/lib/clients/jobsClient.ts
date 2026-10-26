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
 *
 * The wire shapes live in `@taco-ai/protocol` — the same definitions the
 * sidecar serves — so the two halves cannot drift.
 */

import type {
    Actor,
    Job,
    JobCreate,
    JobHistoryEntry,
    JobRunResult,
    JobsCreateParams,
    JobsDeleteResult,
    JobsGetResult,
    JobsHistoryResult,
    JobsIdParams,
    JobsListParams,
    JobsListResult,
    JobsUpdateParams,
    JobsWriteResult,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import type { TacoClient } from "./tacoClient.ts";

export interface JobsClient {
    list(actor?: Actor): Promise<Job[]>;
    get(id: string, actor?: Actor): Promise<Job | null>;
    create(job: JobCreate, actor?: Actor): Promise<Job>;
    update(job: Job, actor?: Actor): Promise<Job>;
    delete(id: string, actor?: Actor): Promise<boolean>;
    runNow(id: string, actor?: Actor): Promise<JobRunResult>;
    history(id: string, actor?: Actor): Promise<JobHistoryEntry[] | null>;
}

export function createJobsClient(client: TacoClient): JobsClient {
    return {
        list: (actor) =>
            call<JobsListParams, JobsListResult>(client, RPC.jobsList, {}, actor).then(
                (r) => r.jobs ?? [],
            ),
        get: (id, actor) =>
            call<JobsIdParams, JobsGetResult>(client, RPC.jobsGet, { id }, actor).then(
                (r) => r.job,
            ),
        create: (job, actor) =>
            call<JobsCreateParams, JobsWriteResult>(client, RPC.jobsCreate, { job }, actor).then(
                (r) => r.job,
            ),
        update: (job, actor) =>
            call<JobsUpdateParams, JobsWriteResult>(client, RPC.jobsUpdate, { job }, actor).then(
                (r) => r.job,
            ),
        delete: (id, actor) =>
            call<JobsIdParams, JobsDeleteResult>(client, RPC.jobsDelete, { id }, actor).then(
                (r) => r.deleted,
            ),
        runNow: (id, actor) =>
            call<JobsIdParams, JobRunResult>(client, RPC.jobsRunNow, { id }, actor),
        history: (id, actor) =>
            call<JobsIdParams, JobsHistoryResult>(client, RPC.jobsHistory, { id }, actor).then(
                (r) => r.history,
            ),
    };
}

/** Process-level RPC for jobs.* — the scheduler lives in the daemon process,
 *  not in any workspace. `callProcess` routes the frame through whichever
 *  workspace is currently started (the daemon's stdin is shared, so any
 *  started cwd works); `call()` would require `params.workspace` to be set
 *  on the sidecar side, which the jobs UI never provides. */
async function call<TParams, TResult>(
    client: TacoClient,
    method: string,
    params: TParams,
    actor: Actor | undefined,
): Promise<TResult> {
    return client.callProcess(method, actor === undefined ? params : { ...params, actor });
}
