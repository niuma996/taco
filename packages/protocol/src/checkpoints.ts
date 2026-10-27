/**
 * Checkpoint RPC types — list / restore of pre-write file snapshots.
 *
 * A checkpoint is captured before the first mutating tool call of a turn and
 * covers the files that turn touched, so restoring one undoes that turn's
 * edits. Restore is deliberately client-driven: it is destructive, so it is not
 * exposed to the model as a tool.
 */

import type { ParamsOf } from "./rpcContract/types.js";
import type { checkpointsListSchema, checkpointsRestoreSchema } from "./schemas/memory.js";

/** One file captured in a checkpoint. */
export interface CheckpointFileEntry {
    /** Absolute path as captured. */
    path: string;
    /** False means the file did not exist; restoring deletes it. */
    existed: boolean;
}

export interface CheckpointEntry {
    id: string;
    /** Session that produced the edits this checkpoint protects. */
    sessionId: string;
    /** ISO 8601 creation timestamp. */
    createdAt: string;
    /** Human-facing origin, e.g. `turn 3` or `pre-restore of <id>`. */
    label: string;
    files: CheckpointFileEntry[];
}

/** `checkpoints.list` — workspace-scoped; omit `sessionId` for all sessions. */
export type CheckpointsListParams = ParamsOf<typeof checkpointsListSchema>;

export interface CheckpointsListResult {
    /** Newest first. */
    checkpoints: CheckpointEntry[];
    /** False means checkpoints are unavailable here (e.g. no filesystem tools). */
    enabled: boolean;
}

/** `checkpoints.restore` — rolls files back to the given checkpoint. */
export type CheckpointsRestoreParams = ParamsOf<typeof checkpointsRestoreSchema>;

export interface CheckpointsRestoreResult {
    /** Paths written back to their captured content. */
    restored: string[];
    /** Paths removed because they did not exist at capture time. */
    deleted: string[];
    /**
     * Paths that could not be restored. A restore is per-file, so a partial
     * result is reported rather than hidden behind an all-or-nothing error.
     */
    failed: Array<{ path: string; reason: string }>;
    /**
     * Checkpoint taken of the pre-restore state, so an unwanted restore can
     * itself be undone. Absent when the target captured no files.
     */
    protectionId?: string;
}
