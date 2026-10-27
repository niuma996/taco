/**
 * RPC contract rows — memory.* / checkpoints.* — user memory, consolidation, and file snapshots.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type {
    CheckpointsListParams,
    CheckpointsListResult,
    CheckpointsRestoreParams,
    CheckpointsRestoreResult,
} from "../checkpoints.js";

import type {
    MemoryDeleteTopicParams,
    MemoryDeleteTopicResult,
    MemoryDreamApplyParams,
    MemoryDreamApplyResult,
    MemoryDreamDiscardParams,
    MemoryDreamDiscardResult,
    MemoryDreamRunParams,
    MemoryDreamRunResult,
    MemoryDreamUndoParams,
    MemoryDreamUndoResult,
    MemoryListParams,
    MemoryListResult,
    MemoryRestoreTopicParams,
    MemoryRestoreTopicResult,
    MemoryUpsertParams,
    MemoryUpsertResult,
    MemoryWriteParams,
    MemoryWriteResult,
} from "../memory.js";
import {
    checkpointsListSchema,
    checkpointsRestoreSchema,
    memoryDeleteTopicSchema,
    memoryDreamApplySchema,
    memoryDreamDiscardSchema,
    memoryDreamRunSchema,
    memoryDreamUndoSchema,
    memoryListSchema,
    memoryRestoreTopicSchema,
    memoryUpsertSchema,
    memoryWriteSchema,
} from "../schemas/index.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const memoryRows = {
    checkpointsList: row<CheckpointsListParams, CheckpointsListResult>()(
        "checkpoints.list",
        "workspace",
        checkpointsListSchema,
    ),
    checkpointsRestore: row<CheckpointsRestoreParams, CheckpointsRestoreResult>()(
        "checkpoints.restore",
        "workspace",
        checkpointsRestoreSchema,
    ),
    memoryList: row<MemoryListParams, MemoryListResult>()(
        "memory.list",
        "workspace",
        memoryListSchema,
    ),
    memoryWrite: row<MemoryWriteParams, MemoryWriteResult>()(
        "memory.write",
        "workspace",
        memoryWriteSchema,
    ),
    memoryDeleteTopic: row<MemoryDeleteTopicParams, MemoryDeleteTopicResult>()(
        "memory.deleteTopic",
        "workspace",
        memoryDeleteTopicSchema,
    ),
    memoryUpsert: row<MemoryUpsertParams, MemoryUpsertResult>()(
        "memory.upsert",
        "workspace",
        memoryUpsertSchema,
    ),
    memoryRestoreTopic: row<MemoryRestoreTopicParams, MemoryRestoreTopicResult>()(
        "memory.restoreTopic",
        "workspace",
        memoryRestoreTopicSchema,
    ),
    memoryDreamRun: row<MemoryDreamRunParams, MemoryDreamRunResult>()(
        "memory.dreamRun",
        "workspace",
        memoryDreamRunSchema,
    ),
    memoryDreamApply: row<MemoryDreamApplyParams, MemoryDreamApplyResult>()(
        "memory.dreamApply",
        "workspace",
        memoryDreamApplySchema,
    ),
    memoryDreamDiscard: row<MemoryDreamDiscardParams, MemoryDreamDiscardResult>()(
        "memory.dreamDiscard",
        "workspace",
        memoryDreamDiscardSchema,
    ),
    memoryDreamUndo: row<MemoryDreamUndoParams, MemoryDreamUndoResult>()(
        "memory.dreamUndo",
        "workspace",
        memoryDreamUndoSchema,
    ),
};

export const memoryMethods = domainMethods(memoryRows);
export const memoryContract = domainContract(memoryRows);
export const memorySchemas = domainSchemas(memoryRows);
