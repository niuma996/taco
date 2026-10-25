/**
 * Memory RPC types — list/write/deleteTopic + model-initiated upsert.
 */

import type { WorkspaceId } from "./frames.js";

/**
 * Hard ceiling on a topic body. Not a target — one topic holds one fact, and
 * the newest 100 topic bodies are injected into every turn's context, so the
 * limit bounds that budget. Enforced by the memory tool schema, the
 * `memory.upsert` handler, and the extractor's truncation.
 */
export const MEMORY_CONTENT_MAX_CHARS = 1000;

// memory.list / memory.write / memory.deleteTopic

/** `memory.list` / `memory.write` / `memory.deleteTopic` — workspace-scoped. */
export interface MemoryListParams {
    workspace: WorkspaceId;
}

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
export interface MemoryDreamRunParams {
    workspace: WorkspaceId;
}
export type MemoryDreamRunResult =
    | { status: "previewed"; preview: MemoryDreamPreview }
    | { status: "skipped" | "failed"; reason: string };

/** `memory.dreamApply` — apply the pending preview (confirms the workspace). */
export interface MemoryDreamApplyParams {
    workspace: WorkspaceId;
    /** The preview id the user reviewed; rejected if a newer preview replaced it. */
    previewId: string;
}
export interface MemoryDreamApplyResult {
    report: MemoryDreamReportSummary;
}

/** `memory.dreamDiscard` — drop the pending preview without applying it. */
export interface MemoryDreamDiscardParams {
    workspace: WorkspaceId;
}
export interface MemoryDreamDiscardResult {
    ok: true;
}

/** `memory.dreamUndo` — revert one applied consolidation. */
export interface MemoryDreamUndoParams {
    workspace: WorkspaceId;
    reportId: string;
}
export interface MemoryDreamUndoResult {
    /** Topics left as they are because they changed after the run. */
    conflicts: string[];
}

/** `memory.restoreTopic` — move an archived topic back into the live set. */
export interface MemoryRestoreTopicParams {
    workspace: WorkspaceId;
    id: string;
}
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
export interface MemoryWriteParams {
    workspace: WorkspaceId;
    content: string;
    /** `memoryHash` from the previous `memory.list`. Rejected if disk content has changed. */
    baseHash: string;
}
export interface MemoryWriteResult {
    ok: true;
}

/** `memory.deleteTopic` params — client supplies the id; the sidecar path-whitelists internally. */
export interface MemoryDeleteTopicParams {
    workspace: WorkspaceId;
    id: string;
    /** The content the client last showed; when it no longer matches disk the
     *  delete is refused with `memory.conflict`. Optional for older clients. */
    expectedContent?: string;
}
export interface MemoryDeleteTopicResult {
    ok: true;
}

// memory.upsert — model-initiated add/replace/remove; the handler dispatches by `action`.

export interface MemoryUpsertParams {
    workspace: WorkspaceId;
    /** add / replace / remove */
    action: "add" | "replace" | "remove";
    /** Matches `^[a-z0-9-]{1,64}$` — kebab-case id, lowercase letters/digits/hyphens, ≤64 chars. Whitelisted by the handler. */
    id: string;
    /** Required on add: human-readable name, ≤60 chars. */
    name?: string;
    /** Optional on add: one-line description used for relevance matching, ≤120 chars. Defaults to `name`. */
    description?: string;
    /** Required on add/replace: body text, ≤MEMORY_CONTENT_MAX_CHARS. */
    content?: string;
    /** Required on add. */
    type?: "user" | "feedback" | "project" | "reference";
}
export interface MemoryUpsertResult {
    ok: true;
    /** "created" | "updated" | "deleted" — the model decides next steps based on this. */
    outcome: "created" | "updated" | "deleted";
}
