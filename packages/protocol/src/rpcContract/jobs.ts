/**
 * RPC contract rows — jobs.* — the scheduler surface.
 *
 * Three tables move together: the wire name, the params/result types, and the
 * params schema. `rpcContract/index.ts` merges them into the single
 * `RPC` / `rpcContract` / `rpcSchemas` exports that the client and the
 * sidecar both read.
 *
 * Adding a method to this domain means adding one entry to each of the three
 * tables below — the compile-time assertions in the index catch a row that
 * was added to one and forgotten in another.
 */

import type {
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
} from "../jobs.js";
import {
    jobsCreateSchema,
    jobsDeleteSchema,
    jobsGetSchema,
    jobsHistorySchema,
    jobsListSchema,
    jobsRunNowSchema,
    jobsUpdateSchema,
} from "../schemas/index.js";
import type { RpcContractRow } from "./types.js";

/** Wire names for this domain. */
export const jobsMethods = {
    jobsList: "jobs.list",
    jobsGet: "jobs.get",
    jobsCreate: "jobs.create",
    jobsUpdate: "jobs.update",
    jobsDelete: "jobs.delete",
    jobsRunNow: "jobs.runNow",
    jobsHistory: "jobs.history",
} as const;

/** Params/result types and routing scope for this domain. */
export const jobsContract = {
    jobsList: { scope: "process" } as RpcContractRow<JobsListParams, JobsListResult, "process">,
    jobsGet: { scope: "process" } as RpcContractRow<JobsIdParams, JobsGetResult, "process">,
    jobsCreate: { scope: "process" } as RpcContractRow<
        JobsCreateParams,
        JobsWriteResult,
        "process"
    >,
    jobsUpdate: { scope: "process" } as RpcContractRow<
        JobsUpdateParams,
        JobsWriteResult,
        "process"
    >,
    jobsDelete: { scope: "process" } as RpcContractRow<JobsIdParams, JobsDeleteResult, "process">,
    jobsRunNow: { scope: "process" } as RpcContractRow<JobsIdParams, JobRunResult, "process">,
    jobsHistory: { scope: "process" } as RpcContractRow<JobsIdParams, JobsHistoryResult, "process">,
};

/** Params schemas for this domain. */
export const jobsSchemas = {
    jobsList: jobsListSchema,
    jobsGet: jobsGetSchema,
    jobsCreate: jobsCreateSchema,
    jobsUpdate: jobsUpdateSchema,
    jobsDelete: jobsDeleteSchema,
    jobsRunNow: jobsRunNowSchema,
    jobsHistory: jobsHistorySchema,
};
