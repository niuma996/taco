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
