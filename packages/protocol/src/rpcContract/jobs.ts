/**
 * RPC contract rows — jobs.* — the scheduler surface.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); the three tables consumed by `rpcContract/index.ts` are
 * derived from those rows.
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
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const jobsRows = {
    jobsList: row<JobsListParams, JobsListResult>()("jobs.list", "process", jobsListSchema),
    jobsGet: row<JobsIdParams, JobsGetResult>()("jobs.get", "process", jobsGetSchema),
    jobsCreate: row<JobsCreateParams, JobsWriteResult>()(
        "jobs.create",
        "process",
        jobsCreateSchema,
    ),
    jobsUpdate: row<JobsUpdateParams, JobsWriteResult>()(
        "jobs.update",
        "process",
        jobsUpdateSchema,
    ),
    jobsDelete: row<JobsIdParams, JobsDeleteResult>()("jobs.delete", "process", jobsDeleteSchema),
    jobsRunNow: row<JobsIdParams, JobRunResult>()("jobs.runNow", "process", jobsRunNowSchema),
    jobsHistory: row<JobsIdParams, JobsHistoryResult>()(
        "jobs.history",
        "process",
        jobsHistorySchema,
    ),
};

export const jobsMethods = domainMethods(jobsRows);
export const jobsContract = domainContract(jobsRows);
export const jobsSchemas = domainSchemas(jobsRows);
