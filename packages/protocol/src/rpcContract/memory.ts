/**
 * RPC contract rows — memory.* / checkpoints.* — user memory, consolidation, and file snapshots.
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
import type { RpcContractRow } from "./types.js";

/** Wire names for this domain. */
export const memoryMethods = {
    checkpointsList: "checkpoints.list",
    checkpointsRestore: "checkpoints.restore",
    // memory.*
    memoryList: "memory.list",
    memoryWrite: "memory.write",
    memoryDeleteTopic: "memory.deleteTopic",
    memoryUpsert: "memory.upsert",
    memoryRestoreTopic: "memory.restoreTopic",
    // memory.dream* — consolidation preview / apply / discard / undo.
    memoryDreamRun: "memory.dreamRun",
    memoryDreamApply: "memory.dreamApply",
    memoryDreamDiscard: "memory.dreamDiscard",
    memoryDreamUndo: "memory.dreamUndo",
    // mcp.* — MCP server discovery and health status.
} as const;

/** Params/result types and routing scope for this domain. */
export const memoryContract = {
    memoryList: { scope: "workspace" } as RpcContractRow<MemoryListParams, MemoryListResult>,
    memoryWrite: { scope: "workspace" } as RpcContractRow<MemoryWriteParams, MemoryWriteResult>,
    memoryDeleteTopic: { scope: "workspace" } as RpcContractRow<
        MemoryDeleteTopicParams,
        MemoryDeleteTopicResult
    >,
    memoryUpsert: { scope: "workspace" } as RpcContractRow<MemoryUpsertParams, MemoryUpsertResult>,
    memoryRestoreTopic: { scope: "workspace" } as RpcContractRow<
        MemoryRestoreTopicParams,
        MemoryRestoreTopicResult
    >,
    memoryDreamRun: { scope: "workspace" } as RpcContractRow<
        MemoryDreamRunParams,
        MemoryDreamRunResult
    >,
    memoryDreamApply: { scope: "workspace" } as RpcContractRow<
        MemoryDreamApplyParams,
        MemoryDreamApplyResult
    >,
    memoryDreamDiscard: { scope: "workspace" } as RpcContractRow<
        MemoryDreamDiscardParams,
        MemoryDreamDiscardResult
    >,
    memoryDreamUndo: { scope: "workspace" } as RpcContractRow<
        MemoryDreamUndoParams,
        MemoryDreamUndoResult
    >,
    checkpointsList: { scope: "workspace" } as RpcContractRow<
        CheckpointsListParams,
        CheckpointsListResult
    >,
    checkpointsRestore: { scope: "workspace" } as RpcContractRow<
        CheckpointsRestoreParams,
        CheckpointsRestoreResult
    >,
};

/** Params schemas for this domain. */
export const memorySchemas = {
    memoryList: memoryListSchema,
    memoryWrite: memoryWriteSchema,
    memoryDeleteTopic: memoryDeleteTopicSchema,
    memoryUpsert: memoryUpsertSchema,
    memoryRestoreTopic: memoryRestoreTopicSchema,
    memoryDreamRun: memoryDreamRunSchema,
    memoryDreamApply: memoryDreamApplySchema,
    memoryDreamDiscard: memoryDreamDiscardSchema,
    memoryDreamUndo: memoryDreamUndoSchema,
    checkpointsList: checkpointsListSchema,
    checkpointsRestore: checkpointsRestoreSchema,
};
