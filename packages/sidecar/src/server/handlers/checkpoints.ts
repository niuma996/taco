/**
 * checkpoints.* handlers — list and restore pre-write file snapshots.
 *
 * Restore is registered as a `command` so a retried frame with the same
 * commandId does not roll the tree back twice. It is intentionally absent from
 * the model's toolset: undo is a human decision, and giving the model one would
 * let it revert its own mistakes out from under the user.
 */

import type {
    CheckpointEntry,
    CheckpointsListParams,
    CheckpointsListResult,
    CheckpointsRestoreParams,
    CheckpointsRestoreResult,
} from "@taco-ai/protocol";
import { checkpointsListSchema, checkpointsRestoreSchema, ErrorCodes } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import type { CheckpointMeta } from "../../checkpoints/store.ts";
import { type MethodCtx, RpcHandlerError, registerMethod } from "../methodRegistry.ts";

function toWire(meta: CheckpointMeta): CheckpointEntry {
    return {
        id: meta.id,
        sessionId: meta.sessionId,
        createdAt: meta.createdAt,
        label: meta.label,
        // The blob hash is an internal storage detail; clients only need to know
        // whether restoring recreates or removes each path.
        files: meta.files.map((f) => ({ path: f.path, existed: f.blob !== null })),
    };
}

export function registerCheckpointsHandlers(): void {
    registerMethod(
        RPC.checkpointsList,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<CheckpointsListParams>): Promise<CheckpointsListResult> => {
            if (!workspace.checkpointStore) return { checkpoints: [], enabled: false };
            const list = await workspace.listCheckpoints(params.sessionId);
            return { checkpoints: list.map(toWire), enabled: true };
        },
        { schema: checkpointsListSchema },
    );

    registerMethod(
        RPC.checkpointsRestore,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<CheckpointsRestoreParams>): Promise<CheckpointsRestoreResult> => {
            if (!params.checkpointId) {
                throw new RpcHandlerError(ErrorCodes.InvalidParams, "checkpointId is required");
            }
            // Restore must run against a known session: the protection snapshot
            // is attributed to it, and an unattributed "detached" label would
            // pollute the workspace-scoped list when sessionId is omitted.
            if (!params.sessionId) {
                throw new RpcHandlerError(
                    ErrorCodes.InvalidParams,
                    "sessionId is required for checkpoints.restore",
                );
            }
            try {
                const { outcome, protectionId } = await workspace.restoreCheckpoint(
                    params.checkpointId,
                    params.sessionId,
                );
                return {
                    restored: outcome.restored,
                    deleted: outcome.deleted,
                    failed: outcome.failed,
                    protectionId,
                };
            } catch (e) {
                throw new RpcHandlerError(
                    ErrorCodes.CheckpointRestoreFailed,
                    e instanceof Error ? e.message : String(e),
                );
            }
        },
        { command: true, schema: checkpointsRestoreSchema },
    );
}
