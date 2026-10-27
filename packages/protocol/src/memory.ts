/**
 * Memory RPC types — list/write/deleteTopic + model-initiated upsert.
 */

import type { ParamsOf } from "./rpcContract/types.js";
import type {
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
} from "./schemas/memory.js";

/**
 * Hard ceiling on a topic body. Not a target — one topic holds one fact, and
 * the newest 100 topic bodies are injected into every turn's context, so the
 * limit bounds that budget. Enforced by the memory tool schema, the
 * `memory.upsert` handler, and the extractor's truncation.
 */
export const MEMORY_CONTENT_MAX_CHARS = 1000;

// memory.list / memory.write / memory.deleteTopic

/** `memory.list` / `memory.write` / `memory.deleteTopic` — workspace-scoped. */
export type MemoryListParams = ParamsOf<typeof memoryListSchema>;

/** One topic entry in `memory.list` (corresponds to `projects/{cwd}/{id}.md`).
 *  Field names align with the sidecar `MemoryEntry`; `createdAt` is the file mtime. */
export interface MemoryTopicEntry {
    /** Filename stem (no `.md` extension), e.g. "user_role". */
    id: string;
    /** Frontmatter `name`. */
    name: string;
    /** Frontmatter `description` — a one-line summary used for relevance matching. */
    description: string;
    type: "user" | "feedback" | "project" | "reference";
    /** Memory body content. */
    content: string;
    /** ISO 8601 timestamp; equals the file mtime. */
    createdAt: string;
    /** ISO timestamp of the most recent replace; absent when never replaced. */
    updatedAt?: string;
}

// ─── dream (memory consolidation) ─────────────────────────────────────────────

/** One proposed consolidation step, as shown in the preview. */
export type MemoryDreamAction =
    | {
          action: "merge";
          sourceIds: string[];
          id: string;
          name: string;
          description: string;
          type: MemoryTopicEntry["type"];
          content: string;
      }
    | { action: "rewrite"; id: string; content: string }
    | { action: "archive"; id: string; reason: string; supersededBy?: string };

export interface MemoryDreamCounts {
    /** Source topics folded by merges. */
    merged: number;
    /** Topics those merges produced. */
    mergedInto: number;
    rewritten: number;
    archived: number;
}

/** A consolidation plan awaiting the user's apply / discard. */
export interface MemoryDreamPreview {
    id: string;
    createdAt: string;
    actions: MemoryDreamAction[];
    /** Content each action was planned against: `before` for rewrites and sources. */
    snapshot: Record<string, string>;
    topicCount: number;
    counts: MemoryDreamCounts;
}

/** An applied consolidation, undoable while its topics are untouched. */
export interface MemoryDreamReportSummary {
    id: string;
    appliedAt: string;
    counts: MemoryDreamCounts;
    /** Actions skipped because their topic changed between planning and apply. */
    skipped: number;
    undoneAt?: string;
}

/** Dream state for one workspace, carried on `memory.list`. */
export interface MemoryDreamState {
    /** The pending preview, if any. */
    pending?: MemoryDreamPreview;
    /** True once the user applied a preview; scheduled runs then apply directly. */
    confirmed: boolean;
    /** ISO time of the last consolidation; absent when never run. */
    lastRunAt?: string;
    /** Newest applied runs first (at most a handful). */
    reports: MemoryDreamReportSummary[];
    /** Topics retired by consolidation (or by archive), restorable. */
    archived: MemoryTopicEntry[];
}

/** `memory.dreamRun` — consolidate this workspace now and return a preview. */
export type MemoryDreamRunParams = ParamsOf<typeof memoryDreamRunSchema>;
export type MemoryDreamRunResult =
    | { status: "previewed"; preview: MemoryDreamPreview }
    | { status: "skipped" | "failed"; reason: string };

/** `memory.dreamApply` — apply the pending preview (confirms the workspace). */
export type MemoryDreamApplyParams = ParamsOf<typeof memoryDreamApplySchema>;
export interface MemoryDreamApplyResult {
    report: MemoryDreamReportSummary;
}

/** `memory.dreamDiscard` — drop the pending preview without applying it. */
export type MemoryDreamDiscardParams = ParamsOf<typeof memoryDreamDiscardSchema>;
export interface MemoryDreamDiscardResult {
    ok: true;
}

/** `memory.dreamUndo` — revert one applied consolidation. */
export type MemoryDreamUndoParams = ParamsOf<typeof memoryDreamUndoSchema>;
export interface MemoryDreamUndoResult {
    /** Topics left as they are because they changed after the run. */
    conflicts: string[];
}

/** `memory.restoreTopic` — move an archived topic back into the live set. */
export type MemoryRestoreTopicParams = ParamsOf<typeof memoryRestoreTopicSchema>;
export interface MemoryRestoreTopicResult {
    ok: true;
}

/** `memory.list` result — returns MEMORY.md + topic list in one round-trip. */
export interface MemoryListResult {
    /** Raw MEMORY.md contents (including the `# Memory` header). Empty when memory is off. */
    memoryContent: string;
    /** sha256 (first 16 hex chars) of `memoryContent`. Used for optimistic-concurrency checks on write. */
    memoryHash: string;
    /** All topics for this workspace, full content included. */
    topics: MemoryTopicEntry[];
    /** False means the memory feature is disabled. UI distinguishes
     *  "no memories yet" from "memory feature is off" — both yield empty
     *  lists but with different copy. */
    enabled: boolean;
    /** Consolidation state; absent when memory is off or the daemon predates 2.4. */
    dream?: MemoryDreamState;
    /** Whether the built-in nightly consolidation job is enabled; absent
     *  when the daemon has no scheduler (stdio / tests). Toggled via
     *  `jobs.update` on the `memory-dream` job. */
    dreamScheduled?: boolean;
    /** Why the scheduler turned the job off by itself (repeated failures);
     *  absent when it is on, or when the user turned it off. */
    dreamPausedReason?: string;
}

/** `memory.write` params — overwrites MEMORY.md wholesale. `baseHash` provides optimistic concurrency. */
export type MemoryWriteParams = ParamsOf<typeof memoryWriteSchema>;
export interface MemoryWriteResult {
    ok: true;
}

/** `memory.deleteTopic` params — client supplies the id; the sidecar path-whitelists internally. */
export type MemoryDeleteTopicParams = ParamsOf<typeof memoryDeleteTopicSchema>;
export interface MemoryDeleteTopicResult {
    ok: true;
}

// memory.upsert — model-initiated add/replace/remove; the handler dispatches by `action`.

export type MemoryUpsertParams = ParamsOf<typeof memoryUpsertSchema>;
export interface MemoryUpsertResult {
    ok: true;
    /** "created" | "updated" | "deleted" — the model decides next steps based on this. */
    outcome: "created" | "updated" | "deleted";
}

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
