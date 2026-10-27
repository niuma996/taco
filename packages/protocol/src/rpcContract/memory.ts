/**
 * RPC contract rows — memory.* / checkpoints.* — user memory, consolidation, and file snapshots.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type { CheckpointsListResult, CheckpointsRestoreResult } from "../checkpoints.js";

import type {
    MemoryDeleteTopicResult,
    MemoryDreamApplyResult,
    MemoryDreamDiscardResult,
    MemoryDreamRunResult,
    MemoryDreamUndoResult,
    MemoryListResult,
    MemoryRestoreTopicResult,
    MemoryUpsertResult,
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
} from "../schemas/memory.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const memoryRows = {
    checkpointsList: row<CheckpointsListResult>()(
        "checkpoints.list",
        "workspace",
        checkpointsListSchema,
    ),
    checkpointsRestore: row<CheckpointsRestoreResult>()(
        "checkpoints.restore",
        "workspace",
        checkpointsRestoreSchema,
    ),
    memoryList: row<MemoryListResult>()("memory.list", "workspace", memoryListSchema),
    memoryWrite: row<MemoryWriteResult>()("memory.write", "workspace", memoryWriteSchema),
    memoryDeleteTopic: row<MemoryDeleteTopicResult>()(
        "memory.deleteTopic",
        "workspace",
        memoryDeleteTopicSchema,
    ),
    memoryUpsert: row<MemoryUpsertResult>()("memory.upsert", "workspace", memoryUpsertSchema),
    memoryRestoreTopic: row<MemoryRestoreTopicResult>()(
        "memory.restoreTopic",
        "workspace",
        memoryRestoreTopicSchema,
    ),
    memoryDreamRun: row<MemoryDreamRunResult>()(
        "memory.dreamRun",
        "workspace",
        memoryDreamRunSchema,
    ),
    memoryDreamApply: row<MemoryDreamApplyResult>()(
        "memory.dreamApply",
        "workspace",
        memoryDreamApplySchema,
    ),
    memoryDreamDiscard: row<MemoryDreamDiscardResult>()(
        "memory.dreamDiscard",
        "workspace",
        memoryDreamDiscardSchema,
    ),
    memoryDreamUndo: row<MemoryDreamUndoResult>()(
        "memory.dreamUndo",
        "workspace",
        memoryDreamUndoSchema,
    ),
};

export const memoryMethods = domainMethods(memoryRows);
export const memoryContract = domainContract(memoryRows);
export const memorySchemas = domainSchemas(memoryRows);
