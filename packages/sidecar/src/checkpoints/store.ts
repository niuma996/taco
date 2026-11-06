/**
 * CheckpointStore — pre-write file snapshots, so a turn's edits can be undone.
 *
 * Layout under `$TACO_HOME/checkpoints/<workspaceHash>/`:
 *   blobs/<sha256>          file contents, content-addressed
 *   index.json              checkpoint metadata, newest last
 *
 * Content addressing means a file rewritten N times in a session stores one
 * blob per distinct content, not per snapshot. Blobs are immutable, so a
 * concurrent writer producing the same bytes is a no-op rather than a race.
 *
 * `index.json` is the one mutable file, so every read-modify-write on it is
 * serialised through a single promise chain and committed atomically
 * (temp + rename). Losing an entry here would silently drop a restore point.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tacoHome } from "../config/tacoHome.ts";

/** One captured file. `content: null` records "did not exist", so restoring deletes it. */
export interface CheckpointFile {
    readonly path: string;
    readonly blob: string | null;
    /** Hash of the file after the edit turn completed. Older records omit it. */
    readonly afterHash?: string | null;
}

export interface CheckpointMeta {
    readonly id: string;
    readonly sessionId: string;
    readonly createdAt: string;
    /** Human-facing origin, e.g. `turn 3` or `pre-restore`. */
    readonly label: string;
    /** Harness turn identity; stable across a session replay. */
    readonly turnId?: string;
    /** Session entry that closes the edit turn, when available. */
    readonly anchorEntryId?: string;
    readonly files: readonly CheckpointFile[];
}

export interface RestoreOutcome {
    readonly restored: string[];
    readonly deleted: string[];
    /** Paths that could not be written back, with the reason. */
    readonly failed: Array<{ path: string; reason: string }>;
    /** Files changed after this checkpoint was created. */
    readonly conflicts: Array<{ path: string; reason: string }>;
}

const INDEX_CAP = 200;

/**
 * Current on-disk schema version for `index.json`. New writes use an envelope
 * (`{ schemaVersion, checkpoints }`); reads accept the pre-versioning bare
 * array as v1. An index from a newer sidecar reports a newer version so the
 * store degrades to "no checkpoints" instead of restoring a stale shape.
 */
const CHECKPOINT_INDEX_SCHEMA_VERSION = 1;

function sha256(buf: Buffer | string): string {
    return createHash("sha256").update(buf).digest("hex");
}

/** Stable per-workspace directory name; the raw path is unusable as one. */
function workspaceKey(cwd: string): string {
    return sha256(cwd).slice(0, 16);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Write `content` to `path` via tmp + rename.
 *
 * `syncParent` controls the durability tier:
 *   - `true` for `index.json`, the single mutable file. Losing its directory
 *     entry on power failure would drop restore points silently, so we pay the
 *     second fsync to force the rename itself to disk.
 *   - `false` for content-addressed blobs. They sit on the editor hot path
 *     (one call per touched file per turn), and a lost blob degrades visibly:
 *     `index.json` still references it, so restore reports that path under
 *     `failed` rather than corrupting anything.
 */
async function atomicWrite(
    path: string,
    content: string | Buffer,
    opts: { syncParent: boolean },
): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await mkdir(dirname(path), { recursive: true });
    const fh = await open(tmp, "w");
    try {
        await fh.writeFile(content);
        await fh.sync();
    } finally {
        await fh.close();
    }
    try {
        await rename(tmp, path);
        if (opts.syncParent) {
            // Parent fsync is best-effort. The data is already on disk via
            // the rename; the fsync only adds a guarantee against power
            // loss between the rename and the directory entry update.
            // Windows commonly returns EPERM (and sandboxed FS layers
            // ENOTSUP) on directory fsync — those are platform limits,
            // not data-loss bugs. A warning keeps a real issue (EACCES,
            // etc.) visible without failing the checkpoint write.
            try {
                const parentFh = await open(dirname(path), "r");
                try {
                    await parentFh.sync();
                } finally {
                    await parentFh.close();
                }
            } catch (e) {
                // Console-only on purpose: this warning fires whenever parent
                // fsync returns EPERM on Windows / SMB shares. Routing it into
                // the structured logger would surface in front of operators
                // on every checkpoint write, but the EPERM is non-actionable
                // (parent dir isn't ours to fsync) — we just keep going.
                // biome-ignore lint/suspicious/noConsole: see comment above.
                console.warn(
                    `atomicWrite: parent fsync failed for ${dirname(path)} (${(e as NodeJS.ErrnoException).code ?? e}), continuing`,
                );
            }
        }
    } catch (e) {
        try {
            await unlink(tmp);
        } catch {
            // cleanup is best-effort; the original error is what matters
        }
        throw e;
    }
}

export class CheckpointStore {
    private readonly root: string;
    private readonly blobsDir: string;
    private readonly indexPath: string;
    /** Serialises read-modify-write on index.json. */
    private chain: Promise<unknown> = Promise.resolve();

    constructor(cwd: string, options?: { home?: string }) {
        const base = options?.home ?? tacoHome();
        this.root = join(base, "checkpoints", workspaceKey(cwd));
        this.blobsDir = join(this.root, "blobs");
        this.indexPath = join(this.root, "index.json");
    }

    private async readIndex(): Promise<CheckpointMeta[]> {
        try {
            const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
            // Pre-versioning indexes were a bare CheckpointMeta[]; treat as v1.
            if (Array.isArray(parsed)) return parsed as CheckpointMeta[];
            const envelope = parsed as { schemaVersion?: unknown; checkpoints?: unknown };
            if (
                typeof envelope?.schemaVersion === "number" &&
                envelope.schemaVersion > CHECKPOINT_INDEX_SCHEMA_VERSION
            ) {
                return [];
            }
            return Array.isArray(envelope?.checkpoints)
                ? (envelope.checkpoints as CheckpointMeta[])
                : [];
        } catch {
            // Missing or corrupt index degrades to "no checkpoints" rather than
            // failing the write that triggered the read.
            return [];
        }
    }

    /**
     * Capture `paths` as they are on disk right now. Absent files are recorded
     * as `blob: null` so a restore removes anything created after this point.
     * Returns undefined when `paths` is empty.
     */
    async create(args: {
        sessionId: string;
        label: string;
        turnId?: string;
        paths: readonly string[];
    }): Promise<CheckpointMeta | undefined> {
        if (args.paths.length === 0) return undefined;

        const files: CheckpointFile[] = [];
        // Blobs written by this call, so a failed index commit can roll them
        // back instead of leaving orphans the index never references.
        const writtenBlobs: string[] = [];
        for (const path of new Set(args.paths)) {
            let blob: string | null = null;
            try {
                const buf = await readFile(path);
                blob = sha256(buf);
                const blobPath = join(this.blobsDir, blob);
                // atomicWrite's tmp + rename makes concurrent same-content
                // writers converge on a single blob; a follow-up write is
                // idempotent because the content is identical.
                // Track only blobs this call actually creates. An already-present
                // blob is shared with an earlier checkpoint, so rolling it back
                // on failure would break that checkpoint's restore.
                const isNew = !(await pathExists(blobPath));
                await atomicWrite(blobPath, buf, { syncParent: false });
                if (isNew) writtenBlobs.push(blobPath);
            } catch (e) {
                // Only a genuinely absent file may be recorded as `blob: null`,
                // because that instructs restore to DELETE the path. A file that
                // exists but cannot be read right now (EACCES, transient EIO, a
                // Windows lock) must not be mistaken for "was not there" —
                // restoring would destroy data the user can still see. Surface
                // it instead: CheckpointManager parks the path and the write is
                // still allowed through, so the edit proceeds unprotected
                // rather than becoming silently destructive later.
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                blob = null;
            }
            files.push({ path, blob });
        }

        const meta: CheckpointMeta = {
            id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
            sessionId: args.sessionId,
            createdAt: new Date().toISOString(),
            label: args.label,
            ...(args.turnId ? { turnId: args.turnId } : {}),
            files,
        };

        const next = this.chain.then(async () => {
            const index = await this.readIndex();
            index.push(meta);
            const pruned = index.length > INDEX_CAP ? index.slice(-INDEX_CAP) : index;
            const envelope = {
                schemaVersion: CHECKPOINT_INDEX_SCHEMA_VERSION,
                checkpoints: pruned,
            };
            await atomicWrite(this.indexPath, JSON.stringify(envelope, null, 2), {
                syncParent: true,
            });
        });
        // `chain` swallows the error so one failed commit does not poison every
        // later create; `await next` still reports it to this caller.
        this.chain = next.catch(() => undefined);
        try {
            await next;
        } catch (e) {
            // The index never referenced this checkpoint, so the blobs we just
            // wrote are unreachable. Remove them rather than leaving garbage a
            // later run would never collect. Content addressing means a blob may
            // be shared with an earlier checkpoint, so ignore removal failures
            // instead of assuming exclusive ownership.
            await Promise.all(
                writtenBlobs.map((p) => rm(p, { force: true }).catch(() => undefined)),
            );
            throw e;
        }
        return meta;
    }

    /**
     * Capture additional paths into an existing checkpoint. The caller uses
     * this when one turn discovers another file after its first write.
     * Existing paths are left untouched so their original pre-turn content is
     * preserved.
     */
    async addFiles(id: string, paths: readonly string[]): Promise<CheckpointMeta> {
        if (paths.length === 0) {
            const existing = await this.get(id);
            if (!existing) throw new Error(`checkpoint not found: ${id}`);
            return existing;
        }

        let updated: CheckpointMeta | undefined;
        const next = this.chain.then(async () => {
            const index = await this.readIndex();
            const current = index.find((checkpoint) => checkpoint.id === id);
            if (!current) throw new Error(`checkpoint not found: ${id}`);
            const known = new Set(current.files.map((file) => file.path));
            const additions = paths.filter((path) => !known.has(path));
            if (additions.length === 0) {
                updated = current;
                return;
            }
            const captured = await this.captureFiles(additions);
            updated = {
                ...current,
                files: [...current.files, ...captured],
            };
            const nextIndex = index.map((checkpoint) =>
                checkpoint.id === id ? updated : checkpoint,
            );
            await atomicWrite(
                this.indexPath,
                JSON.stringify(
                    { schemaVersion: CHECKPOINT_INDEX_SCHEMA_VERSION, checkpoints: nextIndex },
                    null,
                    2,
                ),
                { syncParent: true },
            );
        });
        this.chain = next.catch(() => undefined);
        await next;
        if (!updated) throw new Error(`checkpoint not found: ${id}`);
        return updated;
    }

    /** Record the state after the edit turn, used for optimistic restore safety. */
    async finalize(
        id: string,
        metadata?: { turnId?: string; anchorEntryId?: string },
    ): Promise<CheckpointMeta> {
        const existing = await this.get(id);
        if (!existing) throw new Error(`checkpoint not found: ${id}`);
        const files = await Promise.all(
            existing.files.map(async (file) => ({
                ...file,
                afterHash: await this.currentHash(file.path),
            })),
        );
        let updated: CheckpointMeta | undefined;
        const next = this.chain.then(async () => {
            const index = await this.readIndex();
            const current = index.find((checkpoint) => checkpoint.id === id);
            if (!current) throw new Error(`checkpoint not found: ${id}`);
            updated = {
                ...current,
                files,
                ...(metadata?.turnId ? { turnId: metadata.turnId } : {}),
                ...(metadata?.anchorEntryId ? { anchorEntryId: metadata.anchorEntryId } : {}),
            };
            const nextIndex = index.map((checkpoint) =>
                checkpoint.id === id ? updated : checkpoint,
            );
            await atomicWrite(
                this.indexPath,
                JSON.stringify(
                    { schemaVersion: CHECKPOINT_INDEX_SCHEMA_VERSION, checkpoints: nextIndex },
                    null,
                    2,
                ),
                { syncParent: true },
            );
        });
        this.chain = next.catch(() => undefined);
        await next;
        return updated ?? { ...existing, files };
    }

    async conflicts(id: string): Promise<Array<{ path: string; reason: string }>> {
        const meta = await this.get(id);
        if (!meta) throw new Error(`checkpoint not found: ${id}`);
        const conflicts: Array<{ path: string; reason: string }> = [];
        for (const file of meta.files) {
            if (file.afterHash === undefined) continue;
            const current = await this.currentHash(file.path);
            if (current !== file.afterHash) {
                conflicts.push({
                    path: file.path,
                    reason: "file changed after the assistant edit",
                });
            }
        }
        return conflicts;
    }

    private async captureFiles(paths: readonly string[]): Promise<CheckpointFile[]> {
        const files: CheckpointFile[] = [];
        for (const path of new Set(paths)) {
            let blob: string | null = null;
            try {
                const buf = await readFile(path);
                blob = sha256(buf);
                await atomicWrite(join(this.blobsDir, blob), buf, { syncParent: false });
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
            files.push({ path, blob });
        }
        return files;
    }

    private async currentHash(path: string): Promise<string | null> {
        try {
            return sha256(await readFile(path));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw e;
        }
    }

    /** Newest first. */
    async list(sessionId?: string): Promise<CheckpointMeta[]> {
        await this.chain;
        const all = (await this.readIndex()).reverse();
        return sessionId ? all.filter((c) => c.sessionId === sessionId) : all;
    }

    async get(id: string): Promise<CheckpointMeta | undefined> {
        await this.chain;
        return (await this.readIndex()).find((c) => c.id === id);
    }

    /**
     * Write every captured file back. Each path is independent: one failure is
     * reported in `failed` and does not abort the rest, since a partial restore
     * is more useful than an aborted one. Callers should snapshot first — see
     * `CheckpointManager.restore`.
     */
    async restore(id: string, options?: { allowConflicts?: boolean }): Promise<RestoreOutcome> {
        const meta = await this.get(id);
        if (!meta) throw new Error(`checkpoint not found: ${id}`);

        const conflicts = options?.allowConflicts === false ? await this.conflicts(id) : [];
        const conflictPaths = new Set(conflicts.map((conflict) => conflict.path));
        const outcome: RestoreOutcome = { restored: [], deleted: [], failed: [], conflicts };
        for (const file of meta.files) {
            if (conflictPaths.has(file.path)) continue;
            try {
                if (file.blob === null) {
                    await rm(file.path, { force: true });
                    outcome.deleted.push(file.path);
                    continue;
                }
                const buf = await readFile(join(this.blobsDir, file.blob));
                // Full durability: this writes into the user's working tree, so
                // a rename lost to power failure would lose their source file,
                // not a recreatable cache entry.
                await atomicWrite(file.path, buf, { syncParent: true });
                outcome.restored.push(file.path);
            } catch (e) {
                outcome.failed.push({
                    path: file.path,
                    reason: e instanceof Error ? e.message : String(e),
                });
            }
        }
        return outcome;
    }
}
