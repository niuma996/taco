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
import { dirname, join, resolve as resolveTacoHome } from "node:path";
import { tacoHome } from "../../config/config.ts";
import {
    MEMORY_ENTRY_TYPES,
    MemoryConflictError,
    type MemoryEntry,
    type MemoryEntryType,
    type MemoryStore,
} from "../types.ts";

// ─── constants ────────────────────────────────────────────────────────────────

const MEMORY_INDEX_HEADER = "# Memory\n";

/** Archived topics live here, below the topic dir, so injection never sees them. */
export const ARCHIVE_DIR = "archive";

/** Build a topic file body: YAML frontmatter + content. updatedAt omitted when undefined. */
function buildTopicFile(entry: MemoryEntry): string {
    const fm = [`name: ${entry.name}`, `description: ${entry.description}`, `type: ${entry.type}`];
    fm.push(`createdAt: ${entry.createdAt}`);
    if (entry.updatedAt) fm.push(`updatedAt: ${entry.updatedAt}`);
    return `---\n${fm.join("\n")}\n---\n\n${entry.content}`;
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
    options: { expectedContent?: string } | undefined,
): void {
    if (options?.expectedContent !== undefined && existing.content !== options.expectedContent) {
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
    /** Cached topic list, invalidated by the workspace dir's mtime and any
     *  mutating write. buildMemoryBlock is called on every LLM context build,
     *  so reading + parsing every topic file each time is O(n) sync I/O. */
    private topicsCache: { mtimeMs: number; topics: MemoryEntry[] } | undefined;
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
            if (this.getTopic(entry.id)) {
                throw new Error(`memory topic already exists: ${entry.id}`);
            }
            this.writeTopicFile(entry);
            // Invalidate the topics cache after every write — same pattern as
            // updateTopic / deleteTopic. readTopicsCached's mtime check is
            // unreliable on Windows (NTFS mtime granularity can keep two
            // rapid same-tick writes at the same value), so the cache can
            // otherwise return a stale list that pre-dates this append and
            // miss the newly-written topic.
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

        // Aggregate per-workspace topic summaries. The directory is printed once
        // and each row carries only its id to keep the resident prompt small.
        const MAX_TOPIC_NOTES = 100;
        const sortedTopics = this.listTopics()
            .slice()
            .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
        const topics = sortedTopics.slice(0, MAX_TOPIC_NOTES);

        if (!noteBody && topics.length === 0) return "";

        const parts: string[] = [];
        if (noteBody) parts.push(noteBody);
        if (topics.length > 0) {
            if (parts.length > 0) parts.push("\n---\n");
            parts.push(
                `Workspace memory notes (newest first; use the read tool to fetch <id>.md from ${this.workspaceDir}):`,
            );
            for (const t of topics) {
                // Collapse any embedded newlines so a multiline name/description
                // can't split the list item or smuggle extra lines into <memory>.
                const name = t.name.replace(/[\r\n]+/g, " ").trim();
                const desc = t.description
                    .replace(/[\r\n]+/g, " ")
                    .trim()
                    .slice(0, 80);
                parts.push(`- [${t.type}] ${name} — ${desc} — ${t.id}`);
            }
            const omitted = sortedTopics.length - topics.length;
            if (omitted > 0) {
                parts.push(
                    `${omitted} additional topics not listed; their files remain in the topic directory.`,
                );
            }
        }
        return parts.join("\n");
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
    async deleteTopic(id: string, options?: { expectedContent?: string }): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then(() => {
            const existing = this.readTopicsCached().find((e) => e.id === id);
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
     * existing archived copy with the same id is replaced: the newer archive
     * is the one a restore should bring back.
     */
    async archiveTopic(id: string, options?: { expectedContent?: string }): Promise<void> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then(() => {
            const existing = this.readTopicsCached().find((e) => e.id === id);
            if (!existing) throw new Error(`unknown memory topic: ${id}`);
            assertExpectedContent(existing, options);
            ensureDir(join(this.workspaceDir, ARCHIVE_DIR));
            const archivedPath = join(this.workspaceDir, ARCHIVE_DIR, `${id}.md`);
            // Windows rename does not replace an existing destination.
            if (process.platform === "win32" && existsSync(archivedPath)) {
                unlinkSync(archivedPath);
            }
            renameSync(join(this.workspaceDir, `${id}.md`), archivedPath);
            this.topicsCache = undefined;
        });
        this.writeChain = next.catch(() => undefined);
        return next;
    }

    /** Move an archived topic back. Refuses when a live topic took the id. */
    async restoreTopic(id: string): Promise<void> {
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
            if (this.readTopicsCached().some((e) => e.id === id)) {
                throw new Error(`memory topic already exists: ${id}`);
            }
            renameSync(from, join(this.workspaceDir, `${id}.md`));
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

    /** Synchronous lookup for a single topic. */
    getTopic(id: string): MemoryEntry | undefined {
        if (!this.initialized) {
            throw new Error("LocalMemoryStore not initialized");
        }
        return this.readTopicsCached().find((e) => e.id === id);
    }

    /**
     * replace semantics: verify id exists → overwrite topic file body,
     * preserving createdAt and writing a new updatedAt. Read-validate and
     * write are inside the same writeChain tick with no await between them,
     * closing the TOCTOU window. `expectedContent` turns the write into a
     * compare-and-swap for callers that derived `content` from a snapshot.
     */
    async updateTopic(
        id: string,
        content: string,
        options?: { expectedContent?: string },
    ): Promise<MemoryEntry> {
        if (!this.initialized) {
            return Promise.reject(new Error("LocalMemoryStore not initialized"));
        }
        const next = this.writeChain.then((): MemoryEntry => {
            const topics = this.readTopicsCached();
            const existing = topics.find((e) => e.id === id);
            if (!existing) {
                throw new Error(`unknown memory topic: ${id}`);
            }
            assertExpectedContent(existing, options);
            const updatedAt = new Date().toISOString();
            const newEntry: MemoryEntry = { ...existing, content, updatedAt };
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
     * Return the workspace's topics, cached against the workspace directory's
     * mtime. buildMemoryBlock runs on every LLM context build; without a cache
     * it would readdir + readFileSync + parse every topic file each call.
     * Mutating writes (appendEntry / deleteTopic / updateTopic) clear the cache
     * explicitly, so the mtime check only guards against external edits.
     */
    private readTopicsCached(): MemoryEntry[] {
        const dir = this.workspaceDir;
        let mtimeMs: number;
        try {
            mtimeMs = statSync(dir).mtimeMs;
        } catch {
            this.topicsCache = undefined;
            return [];
        }
        if (this.topicsCache && this.topicsCache.mtimeMs === mtimeMs) {
            return this.topicsCache.topics;
        }
        const topics = readTopicDir(dir, this._workspaceId);
        this.topicsCache = { mtimeMs, topics };
        return topics;
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
} | null {
    const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return null;

    const yaml = match[1];
    if (!yaml) return null;
    const get = (key: string): string => {
        const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
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
    return { name, description, type: typeRaw as MemoryEntryType, createdAt, updatedAt };
}

/** Read all topic files from a project directory. */
export function readProjectTopics(workspaceId: string): MemoryEntry[] {
    const root = join(resolveTacoHome(tacoHome()), "memory", "projects", workspaceKey(workspaceId));
    return readTopicDir(root, workspaceId);
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
            const body = raw.replace(/^---[\s\S]+?---\r?\n/, "");
            entries.push({
                id,
                name: frontmatter.name,
                description: frontmatter.description,
                type: frontmatter.type,
                content: body.trim(),
                createdAt: fileCreatedAt,
                updatedAt: frontmatter.updatedAt,
                workspaceId,
            });
        } catch {
            // skip unreadable files
        }
    }
    return entries;
}
