/**
 * Memory plugin types.
 *
 * Storage layout: user-level MEMORY.md (append-only H2 sections) plus
 * `projects/{workspaceId}/*.md` topic files with frontmatter. Taxonomy
 * aligns with Claude Code's automemory.
 */

import type { MemoryTopicEntry } from "@taco-ai/protocol";
import type { AgentMessage } from "../runtime/pi/types.ts";

export type MemorySource = NonNullable<MemoryTopicEntry["sources"]>[number];

/** Stable union by conversation, write path and optional entry identity; first evidence wins. */
export function unionMemorySources(
    ...groups: readonly (readonly MemorySource[] | undefined)[]
): MemorySource[] {
    const seen = new Set<string>();
    const sources: MemorySource[] = [];
    for (const group of groups) {
        for (const source of group ?? []) {
            const key = JSON.stringify([source.sessionId, source.via, source.entryId ?? null]);
            if (seen.has(key)) {
                const previous = sources.find(
                    (candidate) =>
                        JSON.stringify([
                            candidate.sessionId,
                            candidate.via,
                            candidate.entryId ?? null,
                        ]) === key,
                );
                if (previous && source.explicitlyRequested === true)
                    previous.explicitlyRequested = true;
                continue;
            }
            seen.add(key);
            sources.push({ ...source });
        }
    }
    return sources;
}

export interface MemoryUpdateOptions {
    /** Compare all persisted state inside the serialized store mutation. */
    expectedEntry?: MemoryEntry;
    expectedContent?: string;
    expectedName?: string;
    expectedDescription?: string;
    sources?: readonly MemorySource[];
    name?: string;
    description?: string;
    explicitlyRequested?: boolean;
}

// ─── taxonomy ─────────────────────────────────────────────────────────────────

export const MEMORY_ENTRY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryEntryType = (typeof MEMORY_ENTRY_TYPES)[number];

/** Canonical id for new topics. Existing legacy ids remain valid update targets. */
export function normalizeMemoryTopicId(id: string): string {
    return id
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 64);
}

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
    /** ISO time of the last content/metadata change; source-only writes preserve it. */
    readonly updatedAt?: string;
    readonly sources?: readonly MemorySource[];
    /** Optional workspace this entry is associated with */
    readonly workspaceId?: string;
    readonly explicitlyRequested?: boolean;
    readonly archivedAt?: string;
}

/** Persisted topic state for snapshot CAS; workspace identity is not stored in the file. */
export function memoryEntryState(entry: MemoryEntry): string {
    return JSON.stringify({
        name: entry.name,
        description: entry.description,
        type: entry.type,
        content: entry.content,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        explicitlyRequested: entry.explicitlyRequested,
        archivedAt: entry.archivedAt,
        sources: unionMemorySources(entry.sources).map(
            ({ sessionId, recordedAt, via, entryId, explicitlyRequested }) => ({
                sessionId,
                recordedAt,
                via,
                ...(entryId === undefined ? {} : { entryId }),
                ...(explicitlyRequested === undefined ? {} : { explicitlyRequested }),
            }),
        ),
    });
}

export type ArchiveTopicOptions = MemoryUpdateOptions;

export interface ArchiveCleanupCandidate {
    key: string;
    id: string;
    entry: MemoryEntry;
    archivedAt: string;
}

export interface ArchiveCleanupResult {
    deleted: number;
    skipped: number;
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

    /** Persist a new entry. Rejects an existing id instead of overwriting it. */
    appendEntry(entry: MemoryEntry): Promise<void>;

    /** Read the full user-level MEMORY.md content (already formatted with H2 sections). */
    readMemory(): string;

    /** Build the <memory> tag content block from MEMORY.md. Returns "" when empty. */
    buildMemoryBlock(): string;

    /** Whether memory is enabled. LocalMemoryStore = true, NoOpMemoryStore = false. */
    readonly enabled: boolean;

    /** Directory holding this workspace's topic files; undefined when disabled. */
    readonly topicDir?: string;

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
     *  Same writeChain constraint as writeMemory / appendEntry; rejects when
     *  any supplied snapshot expectation differs from disk. */
    deleteTopic(id: string, options?: MemoryUpdateOptions): Promise<void>;

    /** Synchronous lookup for one topic. Returns undefined when the id is
     *  missing (lets tools list-then-decide without errors). */
    getTopic(id: string): MemoryEntry | undefined;

    /**
     * replace semantics: verify id exists → overwrite topic file body,
     * preserving createdAt/type and merging provenance. Refreshes updatedAt
     * only when trimmed content or metadata changes. Throws if id is not
     * in listTopics(). Read-validate and write must be inside the same
     * writeChain tick — otherwise an extractor appendEntry / client
     * deleteTopic can interleave and overwrite. Expected content/name/description
     * reject stale snapshots before writing, including source-only updates.
     * `expectedEntry` additionally guards type, timestamps and provenance.
     */
    updateTopic(id: string, content: string, options?: MemoryUpdateOptions): Promise<MemoryEntry>;

    archiveTopic?(id: string, options?: ArchiveTopicOptions): Promise<MemoryEntry>;
    restoreTopic?(id: string, options?: Pick<MemoryUpdateOptions, "expectedEntry">): Promise<void>;
    purgeArchivedTopics?(options: {
        retentionDays: 7 | 30 | 90;
        now?: Date;
        protectedIds?: ReadonlySet<string>;
        beforeDelete?: (candidates: readonly ArchiveCleanupCandidate[]) => void;
    }): Promise<ArchiveCleanupResult>;
}

// ─── extractor interface ───────────────────────────────────────────────────────

export interface MemoryExtractor {
    /**
     * Fire-and-forget extraction after each completed run.
     * Admits new user evidence with durable value within an ~8000-character
     * input budget, excluding summaries and tool output. Skips processed
     * message identities and validates model actions against user evidence.
     */
    onRunEnd(
        messages: readonly AgentMessage[],
        options?: { skipThroughEntryId?: string },
    ): Promise<void>;
}

export interface MemoryExtractionGateState {
    pendingRuns: number;
    pendingChars: number;
    lastObservedEntryId?: string;
    lastAttemptAt?: number;
    /** Consecutive failed evaluations; widens the cooldown before the next attempt. */
    failures?: number;
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
