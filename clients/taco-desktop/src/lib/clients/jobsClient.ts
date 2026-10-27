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
    RpcMethodName,
    RpcMethodParams,
    RpcMethodResult,
} from "@taco-ai/protocol";
import type { RpcDispatch } from "@taco-ai/shared";
import { createProcessContractDispatch, RPC } from "@taco-ai/shared";

export interface JobsClient {
    list(actor?: Actor): Promise<Job[]>;
    get(id: string, actor?: Actor): Promise<Job | null>;
    create(job: JobCreate, actor?: Actor): Promise<Job>;
    update(job: Job, actor?: Actor): Promise<Job>;
    delete(id: string, actor?: Actor): Promise<boolean>;
    runNow(id: string, actor?: Actor): Promise<JobRunResult>;
    history(id: string, actor?: Actor): Promise<JobHistoryEntry[] | null>;
}

export function createJobsClient(client: Pick<RpcDispatch, "callProcess">): JobsClient {
    // Bind transport methods: TacoClient.callProcess reads instance state.
    const contract = createProcessContractDispatch({
        callProcess: (method, params) => client.callProcess(method, params),
    });
    const call = <M extends Extract<RpcMethodName, `jobs.${string}`>>(
        method: M,
        params: RpcMethodParams<M>,
        actor?: Actor,
    ): Promise<RpcMethodResult<M>> =>
        contract.callProcess<M>(method, { ...params, ...(actor === undefined ? {} : { actor }) });
    return {
        list: (actor) => call(RPC.jobsList, {}, actor).then((r) => r.jobs ?? []),
        get: (id, actor) => call(RPC.jobsGet, { id }, actor).then((r) => r.job),
        create: (job, actor) => call(RPC.jobsCreate, { job }, actor).then((r) => r.job),
        update: (job, actor) => call(RPC.jobsUpdate, { job }, actor).then((r) => r.job),
        delete: (id, actor) => call(RPC.jobsDelete, { id }, actor).then((r) => r.deleted),
        runNow: (id, actor) => call(RPC.jobsRunNow, { id }, actor),
        history: (id, actor) => call(RPC.jobsHistory, { id }, actor).then((r) => r.history),
    };
}
