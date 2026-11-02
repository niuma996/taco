/**
 * RPC contract rows: work.*, the read-only overview of managed background work.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import { workGetSchema, workListSchema, workRetryDeliverySchema } from "../schemas/work.js";
import type { WorkGetResult, WorkListResult, WorkRetryDeliveryResult } from "../work.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const workRows = {
    workList: row<WorkListResult>()("work.list", "process", workListSchema),
    workGet: row<WorkGetResult>()("work.get", "process", workGetSchema),
    workRetryDelivery: row<WorkRetryDeliveryResult>()(
        "work.retryDelivery",
        "process",
        workRetryDeliverySchema,
    ),
};

export const workMethods = domainMethods(workRows);
export const workContract = domainContract(workRows);
export const workSchemas = domainSchemas(workRows);
