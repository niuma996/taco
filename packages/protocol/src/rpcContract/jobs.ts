/**
 * RPC contract rows — jobs.* — the scheduler surface.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); the three tables consumed by `rpcContract/index.ts` are
 * derived from those rows.
 */

import type {
    JobRunResult,
    JobsDeleteResult,
    JobsGetResult,
    JobsHistoryResult,
    JobsListResult,
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
    jobsList: row<JobsListResult>()("jobs.list", "process", jobsListSchema),
    jobsGet: row<JobsGetResult>()("jobs.get", "process", jobsGetSchema),
    jobsCreate: row<JobsWriteResult>()("jobs.create", "process", jobsCreateSchema),
    jobsUpdate: row<JobsWriteResult>()("jobs.update", "process", jobsUpdateSchema),
    jobsDelete: row<JobsDeleteResult>()("jobs.delete", "process", jobsDeleteSchema),
    jobsRunNow: row<JobRunResult>()("jobs.runNow", "process", jobsRunNowSchema),
    jobsHistory: row<JobsHistoryResult>()("jobs.history", "process", jobsHistorySchema),
};

export const jobsMethods = domainMethods(jobsRows);
export const jobsContract = domainContract(jobsRows);
export const jobsSchemas = domainSchemas(jobsRows);
