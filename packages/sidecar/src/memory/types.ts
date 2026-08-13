/**
 * Memory plugin types.
 *
 * Storage layout: user-level MEMORY.md (append-only H2 sections) plus
 * `projects/{workspaceId}/*.md` topic files with frontmatter. Taxonomy
 * aligns with Claude Code's automemory.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ─── taxonomy ─────────────────────────────────────────────────────────────────

export const MEMORY_ENTRY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryEntryType = (typeof MEMORY_ENTRY_TYPES)[number];

// ─── entry ────────────────────────────────────────────────────────────────────

export interface MemoryEntry {
    /** Filename stem (no .md), e.g. "user_role". */
    readonly id: string;
    /** frontmatter name */
    readonly name: string;
    /** frontmatter description — one-line, used for relevance matching */
    readonly description: string;
    readonly type: MemoryEntryType;
    /** Memory body content */
    readonly content: string;
    readonly createdAt: string; // ISO 8601
    /** ISO time of the last replace; undefined when never updated. */
    readonly updatedAt?: string;
    /** Optional workspace this entry is associated with */
    readonly workspaceId?: string;
}

// ─── memory store interface ───────────────────────────────────────────────────

export interface MemoryStore {
    /**
     * Initialise the memory directory tree for `workspaceId`. Must be called
     * before any other method. Synchronous because the default local store
     * uses sync I/O; a future remote store (e.g. S3) would be a different
     * interface rather than a flag on this one.
     */
    initialize(workspaceId: string): void;

    /**
     * Persist a memory entry. Returns a Promise so implementations may
     * serialise concurrent writers (the read-modify-write in MEMORY.md is
     * not safe under parallel calls).
     */
    appendEntry(entry: MemoryEntry): Promise<void>;

    /** Read the full user-level MEMORY.md content (already formatted with H2 sections). */
    readMemory(): string;

    /** Build the <memory> tag content block from MEMORY.md. Returns "" when empty. */
    buildMemoryBlock(): string;

    /** Whether memory is enabled. LocalMemoryStore = true, NoOpMemoryStore = false. */
    readonly enabled: boolean;

    /**
     * Overwrite MEMORY.md wholesale. Throws MemoryConflictError if `baseHash`
     * doesn't match the on-disk content. Implementations must place the
     * read-validate and write inside the same writeChain tick with no await
     * between them; otherwise an extractor appendEntry will interleave and
     * silently overwrite.
     */
    writeMemory(content: string, baseHash: string): Promise<void>;

    /** List topic entries for the current workspace (reads projects/{ws}/*.md).
     *  Synchronous to match readMemory() — LocalMemoryStore uses sync I/O. */
    listTopics(): MemoryEntry[];

    /** Delete a topic. Throws when the id is not in listTopics().
     *  Same writeChain constraint as writeMemory / appendEntry. */
    deleteTopic(id: string): Promise<void>;

    /** Synchronous lookup for one topic. Returns undefined when the id is
     *  missing (lets tools list-then-decide without errors). */
    getTopic(id: string): MemoryEntry | undefined;

    /**
     * replace semantics: verify id exists → overwrite topic file body,
     * preserving createdAt and writing a new updatedAt. Throws if id is not
     * in listTopics(). Read-validate and write must be inside the same
     * writeChain tick — otherwise an extractor appendEntry / client
     * deleteTopic can interleave and overwrite.
     */
    updateTopic(id: string, content: string): Promise<MemoryEntry>;
}

// ─── extractor interface ───────────────────────────────────────────────────────

export interface MemoryExtractor {
    /**
     * Fire-and-forget extraction after each turn.
     * Gates on token threshold; truncates to ~8000 chars; calls LLM.
     */
    onTurnEnd(messages: readonly AgentMessage[]): Promise<void>;
}

// ─── errors ────────────────────────────────────────────────────────────────────

/** Conflict signal thrown by writeMemory when on-disk hash doesn't match baseHash. */
export class MemoryConflictError extends Error {
    constructor(
        public readonly currentContent: string,
        public readonly currentHash: string,
    ) {
        super("MEMORY.md changed on disk");
        this.name = "MemoryConflictError";
    }
}
