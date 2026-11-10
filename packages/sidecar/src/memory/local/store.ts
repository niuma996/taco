/**
 * LocalMemoryStore — file-backed MemoryStore.
 *
 * All writes are atomic (temp-file + rename) to survive crashes, and serialised
 * through a single Promise chain so concurrent `appendEntry` calls do not lose
 * entries via a read-modify-write race on topic files.
 */

import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolveTacoHome } from "node:path";
import { MEMORY_CONTENT_MAX_CHARS } from "@taco-ai/protocol";
import { tacoHome } from "../../config/config.ts";
import { buildMemoryContextBlock } from "../contextBlock.ts";
import {
    type ArchiveCleanupCandidate,
    type ArchiveCleanupResult,
    type ArchiveTopicOptions,
    MEMORY_ENTRY_TYPES,
    MemoryConflictError,
    type MemoryEntry,
    type MemoryEntryType,
    type MemoryStore,
    type MemoryUpdateOptions,
    memoryEntryState,
    unionMemorySources,
} from "../types.ts";

// ─── constants ────────────────────────────────────────────────────────────────

const MEMORY_INDEX_HEADER = "# Memory\n";

/** Archived topics live here, below the topic dir, so injection never sees them. */
export const ARCHIVE_DIR = "archive";

/** Older archived copies of a re-archived id, under `archive/`. */
const ARCHIVE_HISTORY_DIR = "history";

/** Build a topic file body: YAML frontmatter + content. updatedAt omitted when undefined. */
/** One frontmatter value: a newline would end the field and start another. */
function frontmatterValue(value: string): string {
    return value.replace(/[\r\n]+/g, " ").trim();
}

function buildTopicFile(entry: MemoryEntry): string {
    if (!entry.name.trim()) throw new Error("memory topic name must not be blank");
    const fm = [
        `name: ${frontmatterValue(entry.name)}`,
        `description: ${frontmatterValue(entry.description)}`,
        `type: ${entry.type}`,
    ];
    fm.push(`createdAt: ${entry.createdAt}`);
    if (entry.updatedAt) fm.push(`updatedAt: ${entry.updatedAt}`);
    if (entry.archivedAt) fm.push(`archivedAt: ${entry.archivedAt}`);
    if (entry.explicitlyRequested !== undefined) {
        fm.push(`explicitlyRequested: ${entry.explicitlyRequested}`);
    }
    if (entry.sources?.length) {
        fm.push(`sources: ${JSON.stringify(unionMemorySources(entry.sources))}`);
    }
    // Trimmed because readTopicDir trims the body: what a write returns must
    // equal what the next read sees, or a compare-and-swap against the
    // returned content fails on whitespace alone.
    return `---\n${fm.join("\n")}\n---\n\n${entry.content.trim()}`;
}

function assertBodyLimit(content: string): void {
    if (content.length > MEMORY_CONTENT_MAX_CHARS) {
        throw new Error(`memory topic content must be ≤${MEMORY_CONTENT_MAX_CHARS} characters`);
    }
}

function archiveFiles(workspaceDir: string): string[] {
    const root = join(workspaceDir, ARCHIVE_DIR);
    const result: string[] = [];
    const visit = (dir: string): void => {
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
                name: string;
                isDirectory(): boolean;
                isFile(): boolean;
            }>;
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (entry.isFile() && entry.name.endsWith(".md")) result.push(path);
        }
    };
    visit(root);
    return result;
}

function readArchiveFile(path: string, workspaceId: string | undefined): MemoryEntry | undefined {
    try {
        const raw = readFileSync(path, "utf8");
        const frontmatter = parseTopicFrontmatter(raw);
        if (!frontmatter) return undefined;
        const basename = path.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "";
        const id = basename.includes(".") ? basename.slice(0, basename.indexOf(".")) : basename;
        return {
            id,
            name: frontmatter.name,
            description: frontmatter.description,
            type: frontmatter.type,
            content: raw.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n/, "").trim(),
            createdAt: frontmatter.createdAt ?? statSync(path).mtime.toISOString(),
            ...(frontmatter.updatedAt ? { updatedAt: frontmatter.updatedAt } : {}),
            ...(frontmatter.archivedAt ? { archivedAt: frontmatter.archivedAt } : {}),
            ...(frontmatter.explicitlyRequested ? { explicitlyRequested: true } : {}),
            ...(frontmatter.sources ? { sources: frontmatter.sources } : {}),
            workspaceId,
        };
    } catch {
        return undefined;
    }
}

function isSafeArchivePath(path: string, workspaceDir: string): boolean {
    const root = resolveTacoHome(join(workspaceDir, ARCHIVE_DIR));
    // `relative` normalises separators per platform; comparing against a
    // literal "/" would silently reject every path on Windows.
    const inside = relative(root, resolveTacoHome(path));
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

// ─── helper: hash ───────────────────────────────────────────────────────────────

/**
 * First 16 hex chars of sha256. Shared by writeMemory and the handler so the
 * algorithm can't drift between call sites. Slice length matches
 * memoryTag.ts.
 */
export function hashOf(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ─── helper: atomic write ───────────────────────────────────────────────────────

/** Write content to `path` atomically via temp-file + rename. */
function atomicWrite(path: string, content: string): void {
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tmp, content, "utf8");
        renameSync(tmp, path);
    } catch (e) {
        try {
            unlinkSync(tmp);
        } catch {
            // ignore cleanup failure
        }
        throw e;
    }
}

// ─── helper: compare-and-swap guard ───────────────────────────────────────────

/** Reject a write derived from a snapshot that no longer matches disk. */
function assertExpectedContent(
    existing: MemoryEntry,
    options: MemoryUpdateOptions | undefined,
    ignoreArchivedAt = false,
): void {
    const expectedState =
        options?.expectedEntry === undefined
            ? undefined
            : ignoreArchivedAt
              ? memoryEntryState({ ...options.expectedEntry, archivedAt: undefined })
              : memoryEntryState(options.expectedEntry);
    const existingState = ignoreArchivedAt
        ? memoryEntryState({ ...existing, archivedAt: undefined })
        : memoryEntryState(existing);
    if (
        (expectedState !== undefined && existingState !== expectedState) ||
        (options?.expectedContent !== undefined && existing.content !== options.expectedContent) ||
        (options?.expectedName !== undefined && existing.name !== options.expectedName) ||
        (options?.expectedDescription !== undefined &&
            existing.description !== options.expectedDescription)
    ) {
        throw new Error(`memory topic changed since it was read: ${existing.id}`);
    }
}

// ─── helper: ensure directory exists ──────────────────────────────────────────

function ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/**
 * Stable per-workspace directory name derived from the workspace path.
 *
 * `workspaceId` is the absolute cwd (e.g. `D:\github\nium-wiki` on Windows
 * or `/home/me/proj` on POSIX). It contains characters that are illegal in
 * directory names on Windows (`:` after the drive letter, `\` separators)
 * and on every platform for the shell-injection surface it would create if
 * interpolated into a path. Hash to a 16-char hex prefix so every input —
 * regardless of separator or case — maps to a portable directory name.
 *
 * Forward-slash-normalise the input first so the same logical cwd on
 * different platforms hashes to the same key. (e.g. `D:\a\b` and the
 * drive-letter-cased `d:/A/B` would otherwise hash to different buckets.)
 *
 * Exported so tests (and any future migration tooling) can compute the on-disk
 * directory for a given workspace id instead of hardcoding the raw path.
 */
export function workspaceKey(workspaceId: string): string {
    const normalised = workspaceId.replace(/\\/g, "/");
    return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

// ─── LocalMemoryStore ─────────────────────────────────────────────────────────

export class LocalMemoryStore implements MemoryStore {
    private readonly memoryDir: string;
    private readonly memoryIndex: string;
    private readonly projectsDir: string;
    private initialized = false;
    private _workspaceId?: string;
    /** Project dir name; set by initialize (hash of the id) or openByKey. */
    private _dirKey?: string;
    /** Serialises read-modify-write on topic files (concurrent appends would lose entries). */
    private writeChain: Promise<unknown> = Promise.resolve();
    /** Cached topic list, keyed by every topic file's mtime and size and
     *  cleared by any mutating write. buildMemoryBlock is called on every LLM
     *  context build, so reading + parsing every topic file each time is O(n)
     *  sync I/O; a stat per file is far cheaper than a read + parse. */
    private topicsCache: { signature: string; topics: MemoryEntry[] } | undefined;
    readonly enabled = true;

    private get workspaceDir(): string {
        if (!this._dirKey) throw new Error("LocalMemoryStore not initialized");
        return join(this.projectsDir, this._dirKey);
    }

    constructor() {
        // Resolve at construction so tests can override TACO_HOME before
        // instantiating. Later `tacoHome()` changes are NOT picked up.
        const root = resolveTacoHome(tacoHome(), "memory");
        this.memoryDir = root;
        this.memoryIndex = join(root, "MEMORY.md");
        this.projectsDir = join(root, "projects");
    }

    initialize(workspaceId: string): void {
        if (this.initialized) return;
        this._workspaceId = workspaceId;
        this._dirKey = workspaceKey(workspaceId);
        ensureDir(this.memoryDir);
        if (!existsSync(this.memoryIndex)) {
            atomicWrite(this.memoryIndex, `${MEMORY_INDEX_HEADER}\n`);
        }
        ensureDir(join(this.projectsDir, workspaceKey(workspaceId)));
        this.initialized = true;
    }

    /**
     * Open an existing project dir by its key, for process-level work (dream)
     * that walks `projects/` without knowing the original cwd — the dir name
     * is a one-way hash. Entries read this way carry no `workspaceId`.
     */
    static openByKey(dirKey: string): LocalMemoryStore {
        if (!/^[0-9a-f]{16}$/.test(dirKey)) throw new Error(`invalid memory dir key: ${dirKey}`);
        const store = new LocalMemoryStore();
        store._dirKey = dirKey;
        store.initialized = true;
        return store;
    }

    /** Every project dir key under `projects/`. */
    static listDirKeys(): string[] {
        const root = join(resolveTacoHome(tacoHome(), "memory"), "projects");
        try {
            return readdirSync(root, { withFileTypes: true })
                .filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name))
                .map((d) => d.name);
        } catch {
            return [];
        }
    }

    /** This store's project dir key (its directory name). */
    get dirKey(): string {
        if (!this._dirKey) throw new Error("LocalMemoryStore not initialized");
        return this._dirKey;
    }

    appendEntry(entry: MemoryEntry): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        // Chain to serialize the read-modify-write. Each call extends the
        // chain; work runs in submission order even if callers don't await.
        const next = this.writeChain.then(() => {
            assertBodyLimit(entry.content);
            // Fresh read: a topic the model's write tool just created must
            // block this add rather than be overwritten by it.
            if (this.readTopicsFresh().some((e) => e.id === entry.id)) {
                throw new Error(`memory topic already exists: ${entry.id}`);
            }
            this.writeTopicFile(entry);
            // Invalidate after every write, same as updateTopic / deleteTopic:
            // two rapid writes can land on the same mtime (NTFS granularity),
            // so the signature alone may not notice this append.
            this.topicsCache = undefined;
        });
        // Swallow rejections so one failure doesn't poison subsequent writers.
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    readMemory(): string {
        if (!this.initialized) throw new Error("LocalMemoryStore not initialized");
        try {
            return readFileSync(this.memoryIndex, "utf8");
        } catch {
            return MEMORY_INDEX_HEADER;
        }
    }

    buildMemoryBlock(): string {
        const note = this.readMemory();
        const noteBody = note.trim() === MEMORY_INDEX_HEADER.trim() ? "" : note;

        return buildMemoryContextBlock(
            noteBody,
            [
                {
                    heading: `Workspace memory notes (newest first; use the read tool to fetch <id>.md from ${this.workspaceDir}):`,
                    entries: this.listTopics(),
                },
            ],
            {
                omittedNotice: (count) =>
                    `${count} additional topics not listed; their files remain in the topic directory.`,
                omittedSeparator: "\n",
            },
        );
    }

    /**
     * Overwrite MEMORY.md wholesale with optimistic concurrency control.
     * Throws MemoryConflictError when baseHash is stale. Read-validate and
     * write are inside the same writeChain tick with no await between them —
     * otherwise the TOCTOU window lets an extractor appendEntry interleave
     * and the lock becomes a no-op.
     */
    async writeMemory(content: string, baseHash: string): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then(() => {
            const current = this.readMemory();
            if (hashOf(current) !== baseHash) {
                throw new MemoryConflictError(current, hashOf(current));
            }
            atomicWrite(this.memoryIndex, content);
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** List topics for the current workspace. Serves buildMemoryBlock on every
     *  LLM context build, so results are cached against the workspace dir mtime
     *  to avoid re-reading + parsing every topic file each call. */
    listTopics(): MemoryEntry[] {
        if (!this.initialized) {
            throw new Error("LocalMemoryStore not initialized");
        }
        return this.readTopicsCached();
    }

    /**
     * Delete a topic. Throws when id is not in listTopics(). The check and
     * unlink are inside the chain so an appendEntry / writeMemory cannot
     * interleave between them. `expectedContent` makes it a compare-and-delete.
     */
    async deleteTopic(id: string, options?: MemoryUpdateOptions): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then(() => {
            const existing = this.readTopicsFresh().find((e) => e.id === id);
            if (!existing) throw new Error(`unknown memory topic: ${id}`);
            assertExpectedContent(existing, options);
            unlinkSync(join(this.workspaceDir, `${id}.md`));
            this.topicsCache = undefined;
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** Topic directory for this workspace; dream state lives beside the topics. */
    get topicDir(): string {
        return this.workspaceDir;
    }

    /**
     * Move a topic into `archive/`, out of injection and `listTopics`. An
     * older archived copy with the same id is kept under `archive/history/`
     * rather than overwritten: an undo may still need to bring it back, and
     * the newest copy is the one a restore takes. Returns the validated snapshot
     * captured in this write tick so callers need not reread mutable archives.
     */
    async archiveTopic(id: string, options?: ArchiveTopicOptions): Promise<MemoryEntry> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then(() => {
            const existing = this.readTopicsFresh().find((e) => e.id === id);
            if (!existing) throw new Error(`unknown memory topic: ${id}`);
            assertExpectedContent(existing, options);
            ensureDir(join(this.workspaceDir, ARCHIVE_DIR));
            const archivedPath = join(this.workspaceDir, ARCHIVE_DIR, `${id}.md`);
            if (existsSync(archivedPath)) {
                // readTopicDir ignores subdirectories, so history never shows
                // up as an archived topic or a live one.
                const historyDir = join(this.workspaceDir, ARCHIVE_DIR, ARCHIVE_HISTORY_DIR);
                ensureDir(historyDir);
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                renameSync(
                    archivedPath,
                    join(historyDir, `${id}.${stamp}-${randomUUID().slice(0, 8)}.md`),
                );
            }
            const archivedAt = new Date().toISOString();
            const archived: MemoryEntry = { ...existing, archivedAt };
            atomicWrite(archivedPath, buildTopicFile(archived));
            unlinkSync(join(this.workspaceDir, `${id}.md`));
            this.topicsCache = undefined;
            return archived;
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** Restore inside the write queue, checking archived state before rename. */
    async restoreTopic(
        id: string,
        options?: Pick<MemoryUpdateOptions, "expectedEntry">,
    ): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then(() => {
            // This id crosses the RPC boundary; never let it escape archive/.
            if (
                !id ||
                id === "." ||
                id === ".." ||
                id.includes("/") ||
                id.includes("\\") ||
                id.includes("\0")
            ) {
                throw new Error(`invalid memory topic id: ${id}`);
            }
            const from = join(this.workspaceDir, ARCHIVE_DIR, `${id}.md`);
            if (!existsSync(from)) throw new Error(`unknown archived memory topic: ${id}`);
            if (this.readTopicsFresh().some((e) => e.id === id)) {
                throw new Error(`memory topic already exists: ${id}`);
            }
            if (options?.expectedEntry !== undefined) {
                const archived = readTopicDir(
                    join(this.workspaceDir, ARCHIVE_DIR),
                    this._workspaceId,
                ).find((entry) => entry.id === id);
                if (!archived) throw new Error(`unknown archived memory topic: ${id}`);
                assertExpectedContent(archived, options, true);
            }
            const archived = readTopicDir(
                join(this.workspaceDir, ARCHIVE_DIR),
                this._workspaceId,
            ).find((entry) => entry.id === id);
            if (!archived) throw new Error(`unknown archived memory topic: ${id}`);
            atomicWrite(
                join(this.workspaceDir, `${id}.md`),
                buildTopicFile({ ...archived, archivedAt: undefined }),
            );
            unlinkSync(from);
            this.topicsCache = undefined;
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** Archived topics. Not cached: only the MemoryPane and dream read them. */
    listArchivedTopics(): MemoryEntry[] {
        if (!this.initialized) throw new Error("LocalMemoryStore not initialized");
        return readTopicDir(join(this.workspaceDir, ARCHIVE_DIR), this._workspaceId);
    }

    async purgeArchivedTopics(options: {
        retentionDays: 7 | 30 | 90;
        now?: Date;
        protectedIds?: ReadonlySet<string>;
        beforeDelete?: (candidates: readonly ArchiveCleanupCandidate[]) => void;
    }): Promise<ArchiveCleanupResult> {
        if (!this.initialized) return Promise.reject(new Error("LocalMemoryStore not initialized"));
        const next = this.writeChain.then(() => {
            const now = (options.now ?? new Date()).getTime();
            const cutoff = now - options.retentionDays * 24 * 60 * 60 * 1000;
            const candidates: ArchiveCleanupCandidate[] = [];
            let skipped = 0;
            for (const file of archiveFiles(this.workspaceDir)) {
                const key = file
                    .slice(join(this.workspaceDir, ARCHIVE_DIR).length + 1)
                    .replaceAll("\\", "/");
                const basename = file.split(/[\\/]/).pop()?.replace(/\.md$/, "") ?? "";
                const id = basename.includes(".")
                    ? basename.slice(0, basename.indexOf("."))
                    : basename;
                const entry = readArchiveFile(file, this._workspaceId);
                if (!entry) {
                    skipped++;
                    continue;
                }
                // Legacy archives predate archivedAt. Their creation time is
                // the only durable age signal, so use it instead of resetting
                // the retention window when cleanup first encounters them.
                const archivedAt = entry.archivedAt ?? entry.createdAt;
                if (!Number.isFinite(Date.parse(archivedAt))) {
                    skipped++;
                    continue;
                }
                if (options.protectedIds?.has(id) || Date.parse(archivedAt) > cutoff) {
                    skipped++;
                    continue;
                }
                candidates.push({ key, id, entry, archivedAt });
            }
            options.beforeDelete?.(candidates);
            let deleted = 0;
            const failures: string[] = [];
            for (const candidate of candidates) {
                const path = join(this.workspaceDir, ARCHIVE_DIR, candidate.key);
                if (!isSafeArchivePath(path, this.workspaceDir)) {
                    skipped++;
                    continue;
                }
                try {
                    unlinkSync(path);
                    deleted++;
                } catch (error) {
                    failures.push(`${candidate.key}: ${String(error)}`);
                }
            }
            if (failures.length > 0) {
                throw new Error(
                    `archive cleanup deleted ${deleted}; failed ${failures.length}: ${failures.join("; ")}`,
                );
            }
            return { deleted, skipped };
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** Synchronous lookup for a single topic. */
    getTopic(id: string): MemoryEntry | undefined {
        if (!this.initialized) {
            throw new Error("LocalMemoryStore not initialized");
        }
        return this.readTopicsCached().find((e) => e.id === id);
    }

    /**
     * replace semantics: verify id exists → overwrite topic file body,
     * preserving createdAt/type and merging sources. Only substantive edits
     * refresh updatedAt. Read-validate and
     * write are inside the same writeChain tick with no await between them,
     * closing the TOCTOU window. `expectedContent` turns the write into a
     * compare-and-swap for callers that derived `content` from a snapshot.
     */
    async updateTopic(
        id: string,
        content: string,
        options?: MemoryUpdateOptions,
    ): Promise<MemoryEntry> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then((): MemoryEntry => {
            const topics = this.readTopicsFresh();
            const existing = topics.find((e) => e.id === id);
            if (!existing) {
                throw new Error(`unknown memory topic: ${id}`);
            }
            assertExpectedContent(existing, options);
            assertBodyLimit(content);
            const name =
                options?.name === undefined ? existing.name : frontmatterValue(options.name);
            if (!name.trim()) throw new Error("memory topic name must not be blank");
            const description =
                options?.description === undefined
                    ? existing.description
                    : frontmatterValue(options.description);
            const changed =
                content.trim() !== existing.content.trim() ||
                name !== existing.name ||
                description !== existing.description;
            const sources = unionMemorySources(existing.sources, options?.sources);
            const explicitlyRequested =
                existing.explicitlyRequested === true
                    ? true
                    : (options?.explicitlyRequested ?? existing.explicitlyRequested);
            if (
                !changed &&
                sources.length === (existing.sources?.length ?? 0) &&
                explicitlyRequested === existing.explicitlyRequested
            )
                return existing;
            const newEntry: MemoryEntry = {
                ...existing,
                name,
                description,
                content: content.trim(),
                ...(changed ? { updatedAt: new Date().toISOString() } : {}),
                ...(sources.length ? { sources } : {}),
                ...(explicitlyRequested === undefined ? {} : { explicitlyRequested }),
            };
            const path = join(this.workspaceDir, `${id}.md`);
            atomicWrite(path, buildTopicFile(newEntry));
            this.topicsCache = undefined;
            return newEntry;
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    // ── private helpers ────────────────────────────────────────────────────────

    /**
     * Return the workspace's topics for reading (injection, listing), cached
     * against a signature of every topic file's mtime and size.
     *
     * The directory mtime alone is not enough: the model's write / edit tools
     * rewrite a topic file in place, which changes the file but not the
     * directory, so a dir-mtime cache would keep serving the old content.
     */
    private readTopicsCached(): MemoryEntry[] {
        const dir = this.workspaceDir;
        const signature = topicDirSignature(dir);
        if (signature === undefined) {
            this.topicsCache = undefined;
            return [];
        }
        if (this.topicsCache && this.topicsCache.signature === signature) {
            return this.topicsCache.topics;
        }
        const topics = readTopicDir(dir, this._workspaceId);
        this.topicsCache = { signature, topics };
        return topics;
    }

    /**
     * Read the topics straight from disk, for the compare step of a
     * compare-and-swap write. A cache hit there could compare against content
     * an external edit already replaced and let a stale write through.
     */
    private readTopicsFresh(): MemoryEntry[] {
        this.topicsCache = undefined;
        return this.readTopicsCached();
    }

    /** Write a topic file at projects/{workspaceId}/{id}.md with frontmatter. */
    private writeTopicFile(entry: MemoryEntry): void {
        const path = join(this.workspaceDir, `${entry.id}.md`);
        atomicWrite(path, buildTopicFile(entry));
    }
}

// ─── parser helpers (for reading topic files back) ────────────────────────────

/** Parse frontmatter from a topic file. Returns null if the file has no frontmatter. */
export function parseTopicFrontmatter(raw: string): {
    name: string;
    description: string;
    type: MemoryEntryType;
    createdAt?: string;
    updatedAt?: string;
    archivedAt?: string;
    explicitlyRequested?: boolean;
    sources?: MemoryEntry["sources"];
} | null {
    const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return null;

    const yaml = match[1];
    if (!yaml) return null;
    const get = (key: string): string => {
        const m = yaml.match(new RegExp(`^${key}:[\\t ]*([^\\r\\n]*)$`, "m"));
        return m ? m[1]?.trim() : "";
    };

    const name = get("name");
    const description = get("description");
    const typeRaw = get("type");
    if (!typeRaw || !(MEMORY_ENTRY_TYPES as readonly string[]).includes(typeRaw)) {
        return null;
    }

    const createdAt = get("createdAt") || undefined;
    const updatedAt = get("updatedAt") || undefined;
    const archivedAt = get("archivedAt") || undefined;
    const explicitlyRequestedRaw = get("explicitlyRequested");
    const explicitlyRequested =
        explicitlyRequestedRaw === "true"
            ? true
            : explicitlyRequestedRaw === "false"
              ? false
              : undefined;
    const sources = parseSources(get("sources"));
    return {
        name,
        description,
        type: typeRaw as MemoryEntryType,
        ...(createdAt ? { createdAt } : {}),
        updatedAt,
        ...(archivedAt ? { archivedAt } : {}),
        ...(explicitlyRequested === undefined ? {} : { explicitlyRequested }),
        ...(sources.length ? { sources } : {}),
    };
}

/** Corrupt provenance must not hide an otherwise readable legacy memory. */
function parseSources(raw: string): NonNullable<MemoryEntry["sources"]> {
    try {
        const values: unknown = JSON.parse(raw);
        if (!Array.isArray(values)) return [];
        const sources: NonNullable<MemoryEntry["sources"]>[number][] = [];
        for (const value of values) {
            if (value === null || typeof value !== "object") continue;
            const { sessionId, recordedAt, via, entryId, explicitlyRequested } = value;
            if (
                typeof sessionId !== "string" ||
                !sessionId.trim() ||
                typeof recordedAt !== "string" ||
                !Number.isFinite(Date.parse(recordedAt)) ||
                (via !== "auto" && via !== "tool") ||
                (entryId !== undefined && (typeof entryId !== "string" || !entryId.trim())) ||
                (explicitlyRequested !== undefined && typeof explicitlyRequested !== "boolean")
            )
                continue;
            sources.push({
                sessionId,
                recordedAt,
                via,
                ...(entryId === undefined ? {} : { entryId }),
                ...(explicitlyRequested === undefined ? {} : { explicitlyRequested }),
            });
        }
        return unionMemorySources(sources);
    } catch {
        return [];
    }
}

/** Read all topic files from a project directory. */
export function readProjectTopics(workspaceId: string): MemoryEntry[] {
    const root = join(resolveTacoHome(tacoHome()), "memory", "projects", workspaceKey(workspaceId));
    return readTopicDir(root, workspaceId);
}

/**
 * Change signature of a topic dir: name, mtime and size of every top-level
 * `*.md`. Undefined when the directory cannot be read.
 */
function topicDirSignature(root: string): string | undefined {
    let files: string[];
    try {
        files = readdirSync(root);
    } catch {
        return undefined;
    }
    const parts: string[] = [];
    for (const file of files.sort()) {
        if (!file.endsWith(".md")) continue;
        try {
            const stat = statSync(join(root, file));
            parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
        } catch {
            // Vanished between readdir and stat: leave it out, as readTopicDir does.
        }
    }
    return parts.join("|");
}

/** Parse every top-level `*.md` topic in `root`; subdirectories are ignored. */
function readTopicDir(root: string, workspaceId?: string): MemoryEntry[] {
    if (!existsSync(root)) return [];

    let files: string[];
    try {
        files = readdirSync(root);
    } catch {
        return [];
    }

    const entries: MemoryEntry[] = [];
    for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const id = file.replace(/\.md$/, "");
        try {
            const raw = readFileSync(join(root, file), "utf8");
            const frontmatter = parseTopicFrontmatter(raw);
            // Skip files without a valid frontmatter block. The store only ever
            // writes full-frontmatter topic files, so a frontmatter-less .md in
            // this dir is foreign or corrupt — best-effort skip, not a hard fail.
            if (frontmatter === null) continue;
            // Files without createdAt fall back to the filesystem mtime.
            // (Kept: an old_style fixture exercises it.)
            const fileCreatedAt =
                frontmatter.createdAt ?? statSync(join(root, file)).mtime.toISOString();
            // The closing fence is the first "---" on a line of its own, the
            // same rule parseTopicFrontmatter uses; an unanchored match would
            // stop at a "---" inside a frontmatter value.
            const body = raw.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n/, "");
            entries.push({
                id,
                name: frontmatter.name,
                description: frontmatter.description,
                type: frontmatter.type,
                content: body.trim(),
                createdAt: fileCreatedAt,
                updatedAt: frontmatter.updatedAt,
                ...(frontmatter.archivedAt ? { archivedAt: frontmatter.archivedAt } : {}),
                ...(frontmatter.explicitlyRequested === undefined
                    ? {}
                    : { explicitlyRequested: frontmatter.explicitlyRequested }),
                ...(frontmatter.sources ? { sources: frontmatter.sources } : {}),
                workspaceId,
            });
        } catch {
            // skip unreadable files
        }
    }
    return entries;
}
