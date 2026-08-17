/**
 * jobs.* handler — process-level scheduler API. Lives alongside the
 * other handlers/ entries but is registered last in methods.ts so its
 * `jobs` field on ServerRpcSurface is always populated by the time a
 * client can call it (initialize handshake gates non-init RPCs).
 *
 * The method names live in `scheduler/jobsRpc.ts` rather than
 * `@taco-ai/shared` so PR4 doesn't widen the shared package; the UI
 * mirrors them in `clients/taco-desktop/src/lib/jobsRpc.ts`. Drift
 * would surface as an unknown-method error at the first request.
 *
 * Every method carries a `Type.Any()` placeholder schema — the
 * `schemaValidation` test enforces coverage and rejects methods
 * without one. Real validation is deferred; the handlers' own
 * `expectString` / `assertJob` checks surface `invalid_params` for
 * malformed input today.
 */

import { Type } from "typebox";
import { safeJobId } from "../../scheduler/jobId.ts";
import { JOBS_RPC } from "../../scheduler/jobsRpc.ts";
import type { Job } from "../../scheduler/types.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

// Reserved for future use; today the list endpoint takes no params.
type EmptyParams = Record<string, never>;

interface JobsListResult {
    jobs: Job[];
}

interface JobsGetParams {
    id: string;
}
interface JobsGetResult {
    job: Job | null;
}

interface JobsCreateParams {
    job: Job;
}
interface JobsCreateResult {
    job: Job;
}

interface JobsUpdateParams {
    job: Job;
}
interface JobsUpdateResult {
    job: Job;
}

interface JobsDeleteParams {
    id: string;
}
interface JobsDeleteResult {
    deleted: boolean;
}

interface JobsRunNowParams {
    id: string;
}
interface JobsRunNowResult {
    ran: boolean;
}

interface JobsHistoryParams {
    id: string;
}
interface JobsHistoryResult {
    history: Job["history"] | null;
}

export function registerJobsHandlers(): void {
    registerMethod(
        JOBS_RPC.list,
        false,
        async ({ server }: MethodCtx<EmptyParams>): Promise<JobsListResult> => {
            const jobs = server.jobs ? await server.jobs.list() : [];
            return { jobs };
        },
        { schema: Type.Any() },
    );

    registerMethod(
        JOBS_RPC.get,
        false,
        async ({ server, params }: MethodCtx<JobsGetParams>): Promise<JobsGetResult> => {
            const id = expectString(params, "id");
            safeJobId(id);
            const job = server.jobs ? await server.jobs.get(id) : null;
            return { job };
        },
        { schema: Type.Any() },
    );

    registerMethod(
        JOBS_RPC.create,
        true,
        async ({ server, params }: MethodCtx<JobsCreateParams>): Promise<JobsCreateResult> => {
            if (!server.jobs) throw new RpcHandlerError("not_ready", "scheduler not running");
            const job = assertJob(params, "job");
            safeJobId(job.id);
            const saved = await server.jobs.create(job);
            return { job: saved };
        },
        { schema: Type.Any() },
    );

    registerMethod(
        JOBS_RPC.update,
        true,
        async ({ server, params }: MethodCtx<JobsUpdateParams>): Promise<JobsUpdateResult> => {
            if (!server.jobs) throw new RpcHandlerError("not_ready", "scheduler not running");
            const job = assertJob(params, "job");
            safeJobId(job.id);
            const existing = await server.jobs.get(job.id);
            if (!existing) {
                throw new RpcHandlerError("not_found", `no such job: ${job.id}`);
            }
            const saved = await server.jobs.update(job);
            return { job: saved };
        },
        { schema: Type.Any() },
    );

    registerMethod(
        JOBS_RPC.delete,
        true,
        async ({ server, params }: MethodCtx<JobsDeleteParams>): Promise<JobsDeleteResult> => {
            if (!server.jobs) throw new RpcHandlerError("not_ready", "scheduler not running");
            const id = expectString(params, "id");
            safeJobId(id);
            const existing = await server.jobs.get(id);
            await server.jobs.delete(id);
            return { deleted: existing !== null };
        },
        { schema: Type.Any() },
    );

    registerMethod(
        JOBS_RPC.runNow,
        true,
        async ({ server, params }: MethodCtx<JobsRunNowParams>): Promise<JobsRunNowResult> => {
            if (!server.jobs) throw new RpcHandlerError("not_ready", "scheduler not running");
            const id = expectString(params, "id");
            safeJobId(id);
            const ran = await server.jobs.runNow(id);
            return { ran };
        },
        { schema: Type.Any() },
    );

    registerMethod(
        JOBS_RPC.history,
        false,
        async ({ server, params }: MethodCtx<JobsHistoryParams>): Promise<JobsHistoryResult> => {
            const id = expectString(params, "id");
            safeJobId(id);
            const history = server.jobs ? await server.jobs.history(id) : null;
            return { history };
        },
        { schema: Type.Any() },
    );
}

// Suppress unused warning — EmptyParams documents the intent that
// list() takes no params today; the type alias keeps the schema's `Type.Any()`
// shape honest when we eventually tighten it.
void (null as unknown as EmptyParams);

function expectString(params: unknown, field: string): string {
    if (typeof params !== "object" || params === null) {
        throw new RpcHandlerError(
            "invalid_params",
            `params must be an object (got ${typeof params})`,
        );
    }
    const value = (params as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new RpcHandlerError("invalid_params", `${field} must be a non-empty string`);
    }
    return value;
}

function assertJob(params: unknown, field: string): Job {
    if (typeof params !== "object" || params === null) {
        throw new RpcHandlerError(
            "invalid_params",
            `params must be an object (got ${typeof params})`,
        );
    }
    const candidate = (params as Record<string, unknown>)[field];
    if (typeof candidate !== "object" || candidate === null) {
        throw new RpcHandlerError("invalid_params", `${field} must be a job object`);
    }
    const obj = candidate as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.length === 0) {
        throw new RpcHandlerError("invalid_params", `${field}.id must be a non-empty string`);
    }
    if (typeof obj.name !== "string") {
        throw new RpcHandlerError("invalid_params", `${field}.name must be a string`);
    }
    if (!isScheduleSpec(obj.schedule)) {
        throw new RpcHandlerError("invalid_params", `${field}.schedule is malformed`);
    }
    if (typeof obj.command !== "string") {
        throw new RpcHandlerError("invalid_params", `${field}.command must be a string`);
    }
    if (typeof obj.args !== "object" || obj.args === null) {
        throw new RpcHandlerError("invalid_params", `${field}.args must be an object`);
    }
    if (typeof obj.enabled !== "boolean") {
        throw new RpcHandlerError("invalid_params", `${field}.enabled must be a boolean`);
    }
    if (typeof obj.run_on_startup !== "boolean") {
        throw new RpcHandlerError("invalid_params", `${field}.run_on_startup must be a boolean`);
    }
    return obj as unknown as Job;
}

function isScheduleSpec(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const s = value as Record<string, unknown>;
    if (s.kind === "cron") {
        return (
            typeof s.expr === "string" &&
            s.expr.length > 0 &&
            (s.tz === undefined || typeof s.tz === "string")
        );
    }
    if (s.kind === "interval") {
        return typeof s.ms === "number" && Number.isInteger(s.ms) && s.ms > 0;
    }
    return false;
}
