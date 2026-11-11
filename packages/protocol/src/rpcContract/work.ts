/**
 * RPC contract rows for managed background work.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import {
    workCancelSchema,
    workDeleteSchema,
    workGetSchema,
    workListSchema,
    workQueueCancelSchema,
    workRetryDeliverySchema,
} from "../schemas/work.js";
import type {
    WorkCancelResult,
    WorkDeleteResult,
    WorkGetResult,
    WorkListResult,
    WorkQueueCancelResult,
    WorkRetryDeliveryResult,
} from "../work.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const workRows = {
    workCancel: row<WorkCancelResult>()("work.cancel", "process", workCancelSchema),
    workQueueCancel: row<WorkQueueCancelResult>()(
        "work.queueCancel",
        "process",
        workQueueCancelSchema,
    ),
    workDelete: row<WorkDeleteResult>()("work.delete", "process", workDeleteSchema),
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
