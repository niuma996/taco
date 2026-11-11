/**
 * File-backed Work store: `<root>/<workId>/work.json` is the authoritative
 * snapshot, `results/<resultId>.json` holds the immutable answer.
 *
 * The write path is the same shape as `scheduler/store.ts`: one in-memory
 * queue per id, a unique temp file, then `rename`. That survives a crashed
 * process leaving a half-written file; it does not promise durability across
 * power loss (no fsync), which this ledger does not claim.
 *
 * Every path is derived from an id that passed `assertSafeWorkId`. No RPC
 * accepts a path.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionTarget } from "@taco-ai/protocol";
import { WORK_STATUSES } from "@taco-ai/protocol";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";
import { writeJsonAtomic } from "../store/atomicFile.ts";
import {
    type IndexEntry,
    readIndex,
    sameStamp,
    stampOf,
    tryWriteIndex,
} from "../store/indexFile.ts";
import { KeyedQueue } from "../store/serial.ts";
import { isTerminal, WORK_SCHEMA_VERSION, type WorkRecord } from "./workTypes.ts";

const log = createLogger("sidecar.work.store");

const JSON_INDENT = 2;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Not records. Their names match `isSafeWorkId`, so a scan must skip them. */
const RESERVED_DIRS = new Set(["deleted", "interactions"]);
/** Leading `_` so the id validator never treats the cache as a record. */
export const WORK_INDEX_FILE = "_work-index.json";

export function isSafeWorkId(id: string): boolean {
    return SAFE_ID.test(id);
}

function isWorkDir(name: string): boolean {
    return isSafeWorkId(name) && !RESERVED_DIRS.has(name);
}

export function assertSafeWorkId(id: string): void {
    if (!isSafeWorkId(id)) throw new Error(`unsafe work id: ${JSON.stringify(id)}`);
}

/**
 * Stable id for one source event, so a repeat launch maps to the same Work.
 * The workspace is part of the hash: two projects may hold the same session
 * id, and their source events must never share a record.
 */
export function workIdForSource(sourceEventId: string, workspace?: string): string {
    if (workspace === undefined) return legacyWorkIdForSource(sourceEventId);
    return `w-${createHash("sha256")
        .update(`${workspace}\n${sourceEventId}`)
        .digest("hex")
        .slice(0, 32)}`;
}

/**
 * The id scheme from before ids carried the workspace: the source hash alone.
 * Records written under it keep their id; lookups and replays resolve through
 * it so an upgrade never strands or duplicates them.
 */
export function legacyWorkIdForSource(sourceEventId: string): string {
    return `w-${createHash("sha256").update(sourceEventId).digest("hex").slice(0, 32)}`;
}

export interface StoredResult {
    readonly resultId: string;
    readonly workId: string;
    readonly attemptId: string;
    readonly checksum: string;
    readonly text: string;
    readonly createdAt: number;
}

export function checksumOf(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Fields identity resolution and cancellation checks need, and nothing else. */
interface WorkSummary {
    readonly sourceEventId: string;
    readonly workspace?: string;
    readonly status: WorkRecord["status"];
    readonly cancelRequestedAt?: number;
    readonly operation?: {
        readonly workspace: string;
        readonly sessionId: string;
        readonly operationId: string;
    };
}

function isWorkStatus(value: unknown): value is WorkRecord["status"] {
    return typeof value === "string" && WORK_STATUSES.some((status) => status === value);
}

function isWorkSummary(value: unknown): value is WorkSummary {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const summary = value as Record<string, unknown>;
    if (typeof summary.sourceEventId !== "string" || !isWorkStatus(summary.status)) return false;
    if (summary.workspace !== undefined && typeof summary.workspace !== "string") return false;
    if (summary.cancelRequestedAt !== undefined && !Number.isFinite(summary.cancelRequestedAt))
        return false;
    if (summary.operation === undefined) return true;
    if (typeof summary.operation !== "object" || summary.operation === null) return false;
    const operation = summary.operation as Record<string, unknown>;
    return (
        typeof operation.workspace === "string" &&
        typeof operation.sessionId === "string" &&
        typeof operation.operationId === "string"
    );
}

function summaryOf(record: WorkRecord): WorkSummary {
    const operation = record.attempt.operation;
    const cancelRequestedAt = record.attempt.cancelRequestedAt;
    return {
        sourceEventId: typeof record.sourceEventId === "string" ? record.sourceEventId : "",
        ...(typeof record.workspace === "string" ? { workspace: record.workspace } : {}),
        status: record.status,
        ...(typeof cancelRequestedAt === "number" && Number.isFinite(cancelRequestedAt)
            ? { cancelRequestedAt }
            : {}),
        ...(operation &&
        typeof operation.workspace === "string" &&
        typeof operation.sessionId === "string" &&
        typeof operation.operationId === "string"
            ? {
                  operation: {
                      workspace: operation.workspace,
                      sessionId: operation.sessionId,
                      operationId: operation.operationId,
                  },
              }
            : {}),
    };
}

function sameSummary(a: WorkSummary, b: WorkSummary): boolean {
    return (
        a.sourceEventId === b.sourceEventId &&
        a.workspace === b.workspace &&
        a.status === b.status &&
        a.cancelRequestedAt === b.cancelRequestedAt &&
        a.operation?.workspace === b.operation?.workspace &&
        a.operation?.sessionId === b.operation?.sessionId &&
        a.operation?.operationId === b.operation?.operationId &&
        (a.operation === undefined) === (b.operation === undefined)
    );
}

function sameIndex(
    cached: Record<string, IndexEntry<WorkSummary>> | undefined,
    next: Record<string, IndexEntry<WorkSummary>>,
): boolean {
    if (!cached) return false;
    const ids = Object.keys(next);
    if (ids.length !== Object.keys(cached).length) return false;
    return ids.every((id) => {
        const previous = cached[id];
        const entry = next[id];
        return (
            previous !== undefined &&
            entry !== undefined &&
            sameStamp(previous.stamp, entry.stamp) &&
            sameSummary(previous.summary, entry.summary)
        );
    });
}

type WorkIdResolution = { kind: "found"; workId: string } | { kind: "missing" | "ambiguous" };

export class WorkStore {
    private readonly queue = new KeyedQueue();

    constructor(private readonly root: string) {}

    private dir(workId: string): string {
        assertSafeWorkId(workId);
        return join(this.root, workId);
    }

    /**
     * Create the Work, or return the one that already exists for this source.
     * `created` tells the caller whether it won the race.
     *
     * `aliasId` is the id this source had before ids carried the workspace: a
     * record stored there is adopted as-is, and its deletion marker still
     * blocks the replay. Without it an upgraded daemon would spawn a second
     * Work for a source it already tracks.
     */
    async createIfAbsent(
        record: WorkRecord,
        aliasId?: string,
    ): Promise<{ record: WorkRecord; created: boolean }> {
        const create = async () => {
            if (await this.isDeleted(record.workId)) throw new Error("work source was deleted");
            const existing = await this.readSnapshot(record.workId);
            if (existing) return { record: existing, created: false };
            if (aliasId !== undefined && aliasId !== record.workId) {
                if (await this.isDeleted(aliasId)) {
                    const marker = JSON.parse(
                        await readFile(join(this.root, "deleted", `${aliasId}.json`), "utf8"),
                    ) as { workspace?: string };
                    // Old markers carry no attribution; keep their deletion conservative.
                    if (marker.workspace === undefined || marker.workspace === record.workspace)
                        throw new Error("work source was deleted");
                }
                const legacy = await this.readSnapshot(aliasId);
                if (
                    legacy?.sourceEventId === record.sourceEventId &&
                    legacy.workspace === record.workspace
                )
                    return { record: legacy, created: false };
                if (
                    !legacy &&
                    !(await this.isDeleted(aliasId)) &&
                    (await this.hasSnapshot(aliasId))
                )
                    throw new Error("cannot replace an unrecognized work snapshot");
            }
            if (
                record.workspace !== undefined &&
                record.workId === legacyWorkIdForSource(record.sourceEventId)
            ) {
                const scopedId = workIdForSource(record.sourceEventId, record.workspace);
                if (await this.isDeleted(scopedId)) throw new Error("work source was deleted");
                const scoped = await this.readSnapshot(scopedId);
                if (scoped) return { record: scoped, created: false };
            }
            const snapshotExists = await stat(join(this.dir(record.workId), "work.json")).then(
                () => true,
                (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return false;
                    throw error;
                },
            );
            if (snapshotExists) throw new Error("cannot replace an unrecognized work snapshot");
            await this.write(record);
            return { record, created: true };
        };
        // Both schemes share the legacy queue; canonical mutations retain their per-id queue.
        return aliasId !== undefined && aliasId !== record.workId
            ? this.withQueue(aliasId, () => this.withQueue(record.workId, create))
            : this.withQueue(record.workId, create);
    }

    async get(workId: string): Promise<WorkRecord | undefined> {
        assertSafeWorkId(workId);
        return this.readSnapshot(workId);
    }

    /**
     * The canonical id behind a possibly-stale one. A record written before
     * ids carried the workspace answers to both its stored id and the
     * composite a caller computes today. Unknown or ambiguous aliases resolve
     * to undefined. Deleted owners still resolve so they cannot change projects.
     */
    async resolveId(workId: string): Promise<string | undefined> {
        const resolved = await this.resolveIdentity(workId);
        return resolved.kind === "found" ? resolved.workId : undefined;
    }

    /** Notifications distinguish an untracked source from an ambiguous tracked alias. */
    async resolveIdentity(workId: string): Promise<WorkIdResolution> {
        assertSafeWorkId(workId);
        // A deleted or unreadable direct owner must never retarget a different project.
        if ((await this.isDeleted(workId)) || (await this.hasSnapshot(workId)))
            return { kind: "found", workId };
        const identities: Pick<WorkRecord, "workId" | "sourceEventId" | "workspace">[] = [];
        for (const [id, summary] of await this.summaries()) {
            identities.push({
                workId: id,
                sourceEventId: summary.sourceEventId,
                ...(summary.workspace !== undefined ? { workspace: summary.workspace } : {}),
            });
        }
        const markers = await readdir(join(this.root, "deleted")).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        });
        for (const file of markers) {
            if (!file.endsWith(".json") || !isSafeWorkId(file.slice(0, -5))) continue;
            const marker = JSON.parse(
                await readFile(join(this.root, "deleted", file), "utf8"),
            ) as Partial<WorkRecord>;
            if (marker.workId === file.slice(0, -5) && typeof marker.sourceEventId === "string")
                identities.push({
                    workId: marker.workId,
                    sourceEventId: marker.sourceEventId,
                    ...(typeof marker.workspace === "string"
                        ? { workspace: marker.workspace }
                        : {}),
                });
        }
        const matches = new Set(
            identities
                .filter(
                    (record) =>
                        legacyWorkIdForSource(record.sourceEventId) === workId ||
                        (record.workspace !== undefined &&
                            workIdForSource(record.sourceEventId, record.workspace) === workId),
                )
                .map((record) => record.workId),
        );
        if (matches.size === 0) return { kind: "missing" };
        if (matches.size > 1) return { kind: "ambiguous" };
        for (const id of matches) return { kind: "found", workId: id };
        return { kind: "missing" };
    }

    /**
     * Permission and cancel checks ask this on the hot path. The summary index
     * answers it; `list()` still reads each record.
     */
    async cancellationRequested(
        workspace: string,
        sessionId: string,
        operationId: string,
    ): Promise<boolean> {
        for (const summary of (await this.summaries()).values()) {
            if (
                summary.status === "running" &&
                summary.cancelRequestedAt !== undefined &&
                summary.operation?.workspace === workspace &&
                summary.operation.sessionId === sessionId &&
                summary.operation.operationId === operationId
            )
                return true;
        }
        return false;
    }

    /** Distinguish absent legacy sources from existing snapshots that could not be decoded. */
    async hasSnapshot(workId: string): Promise<boolean> {
        try {
            await stat(join(this.dir(workId), "work.json"));
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }

    /**
     * Serialized read-modify-write. Returning `undefined` from the update leaves
     * the record as it is.
     *
     * `changed` says whether a write happened. Callers must use it rather than
     * truthiness of `record`: a declined update still resolves with the current
     * snapshot (so a caller can read what blocked it), and acting on that
     * snapshot as if this call succeeded is how a no-op settle used to fire a
     * push and drop its delivery intent.
     */
    async mutate(
        workId: string,
        update: (current: WorkRecord) => WorkRecord | undefined,
    ): Promise<{ record: WorkRecord; changed: boolean } | undefined> {
        return this.withQueue(workId, async () => {
            const current = await this.readSnapshot(workId);
            if (!current) return undefined;
            const next = update(current);
            if (!next) return { record: current, changed: false };
            if (next.workId !== workId) throw new Error("work mutation cannot change workId");
            const stamped: WorkRecord = { ...next, revision: current.revision + 1 };
            await this.persistInvalidatedInteraction(stamped);
            await this.write(stamped);
            return { record: stamped, changed: true };
        });
    }

    /**
     * The Work a child session belongs to, if any. Used to close the loop when a
     * resumed subagent finishes: `agentContinue` has no launch tool call, so the
     * child session id is the only key back to the record.
     */
    async findByChildSessionId(
        childSessionId: string,
        workspace?: string,
    ): Promise<WorkRecord | undefined> {
        for (const record of await this.list()) {
            if (
                record.childSessionId === childSessionId &&
                (workspace === undefined || record.workspace === workspace)
            )
                return record;
        }
        return undefined;
    }

    async list(): Promise<WorkRecord[]> {
        const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
        const records: WorkRecord[] = [];
        for (const e of entries) {
            if (!e.isDirectory() || !isWorkDir(e.name)) continue;
            const record = await this.readSnapshot(e.name);
            if (record) records.push(record);
        }
        return records.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Identity and cancellation only need a few fields. Cache a miss only when
     * the stamp is stable across the read: this store has no global chain, so a
     * write between the stat and the read must not be pinned to the old summary.
     * A tombstone does not change `work.json`, so one `deleted/` read drops those
     * ids even when the stamp still matches.
     */
    private async summaries(): Promise<Map<string, WorkSummary>> {
        const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
        const ids = entries.filter((e) => e.isDirectory() && isWorkDir(e.name)).map((e) => e.name);
        const [cached, tombstones] = await Promise.all([
            readIndex(this.root, WORK_INDEX_FILE, isSafeWorkId, isWorkSummary),
            this.tombstoneIds(),
        ]);
        const result = new Map<string, WorkSummary>();
        const next: Record<string, IndexEntry<WorkSummary>> = {};
        for (const id of ids) {
            if (tombstones.has(id)) continue;
            const path = join(this.dir(id), "work.json");
            const before = await stampOf(path);
            if (!before) continue;
            const previous = cached?.[id];
            if (previous && sameStamp(previous.stamp, before)) {
                result.set(id, previous.summary);
                next[id] = { stamp: before, summary: previous.summary };
                continue;
            }
            const record = await this.readSnapshotFile(id);
            const after = await stampOf(path);
            if (!record || !after || !sameStamp(before, after)) {
                if (record) result.set(id, summaryOf(record));
                continue;
            }
            const summary = summaryOf(record);
            result.set(id, summary);
            next[id] = { stamp: after, summary };
        }
        // A missing store must not be created by a read. Skip the write when
        // nothing changed so a hot check does not rewrite the index every time.
        if (!sameIndex(cached, next) && (Object.keys(next).length > 0 || cached !== undefined))
            await tryWriteIndex(this.root, WORK_INDEX_FILE, next);
        return result;
    }

    async delete(workId: string): Promise<void> {
        await this.withQueue(workId, () => rm(this.dir(workId), { recursive: true, force: true }));
    }

    /** Recheck inside the same queue as mutations so pruning cannot remove a resumed run. */
    async deleteIfUnchanged(snapshot: WorkRecord): Promise<boolean> {
        return this.withQueue(snapshot.workId, async () => {
            const current = await this.readSnapshot(snapshot.workId);
            if (
                !current ||
                current.revision !== snapshot.revision ||
                current.attempt.attemptId !== snapshot.attempt.attemptId ||
                !isTerminal(current.status) ||
                current.delivery?.status === "pending"
            )
                return false;
            await this.persistInvalidatedInteraction(current);
            await rm(this.dir(current.workId), { recursive: true, force: true });
            return true;
        });
    }

    private interactionPath(target: SessionTarget, toolCallId: string): string {
        const key = createHash("sha256")
            .update(JSON.stringify([target.workspace, target.sessionId, toolCallId]))
            .digest("hex");
        return join(this.root, "interactions", `${key}.json`);
    }

    async isInteractionInvalidated(target: SessionTarget, toolCallId: string): Promise<boolean> {
        try {
            await stat(this.interactionPath(target, toolCallId));
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }

    private async persistInvalidatedInteraction(record: WorkRecord): Promise<void> {
        const interaction = record.expiredInteraction ?? record.invalidatedInteraction;
        if (!record.workspace || !interaction) return;
        const path = this.interactionPath(
            { workspace: record.workspace, sessionId: interaction.sessionId },
            interaction.toolCallId,
        );
        await this.ensureDir(dirname(path));
        await writeJsonAtomic(path, { invalidated: true }, { secure: true });
    }

    async isDeleted(workId: string): Promise<boolean> {
        assertSafeWorkId(workId);
        try {
            await stat(join(this.root, "deleted", `${workId}.json`));
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }

    private async tombstoneIds(): Promise<Set<string>> {
        const files = await readdir(join(this.root, "deleted")).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        });
        return new Set(
            files
                .filter((file) => file.endsWith(".json") && isSafeWorkId(file.slice(0, -5)))
                .map((file) => file.slice(0, -5)),
        );
    }

    /** The compact marker outlives result cleanup so replay cannot recreate the source. */
    async markDeleted(workId: string): Promise<"deleted" | "not_found" | "running"> {
        return this.withQueue(workId, async () => {
            if (await this.isDeleted(workId)) return "deleted";
            const current = await this.readSnapshot(workId);
            if (!current) return "not_found";
            if (!isTerminal(current.status)) return "running";
            await this.persistInvalidatedInteraction(current);
            const dir = join(this.root, "deleted");
            await this.ensureDir(dir);
            await writeJsonAtomic(
                join(dir, `${workId}.json`),
                {
                    workId,
                    sourceEventId: current.sourceEventId,
                    workspace: current.workspace,
                    deletedAt: Date.now(),
                },
                { secure: true },
            );
            return "deleted";
        });
    }

    async cleanupDeleted(): Promise<void> {
        const entries = await readdir(join(this.root, "deleted")).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        });
        for (const file of entries) {
            if (!file.endsWith(".json")) continue;
            const id = file.slice(0, -5);
            if (isSafeWorkId(id)) await this.delete(id);
        }
    }

    /**
     * Write the immutable answer. The resultId is derived from the checksum, so
     * rewriting the same text is a no-op rather than a second copy.
     */
    async writeResult(args: {
        workId: string;
        attemptId: string;
        text: string;
        now: number;
    }): Promise<StoredResult> {
        return this.withQueue(args.workId, () => this.writeResultUnlocked(args));
    }

    private async writeResultUnlocked(args: {
        workId: string;
        attemptId: string;
        text: string;
        now: number;
    }): Promise<StoredResult> {
        if (await this.isDeleted(args.workId)) throw new Error("work source was deleted");
        const checksum = checksumOf(args.text);
        const resultId = `r-${checksum.slice(0, 24)}`;
        const stored: StoredResult = {
            resultId,
            workId: args.workId,
            attemptId: args.attemptId,
            checksum,
            text: args.text,
            createdAt: args.now,
        };
        const dir = join(this.dir(args.workId), "results");
        await this.ensureDir(dir);
        const final = join(dir, `${resultId}.json`);
        if (
            await stat(final).then(
                () => true,
                () => false,
            )
        )
            return stored;
        await writeJsonAtomic(final, stored, { indent: JSON_INDENT, secure: true });
        return stored;
    }

    /** Read a result and verify it still matches the record that points at it. */
    async readResult(
        workId: string,
        resultId: string,
        checksum: string,
    ): Promise<StoredResult | undefined> {
        if (!isSafeWorkId(resultId)) return undefined;
        try {
            const raw = await readFile(
                join(this.dir(workId), "results", `${resultId}.json`),
                "utf8",
            );
            const parsed = JSON.parse(raw) as StoredResult;
            if (parsed.workId !== workId || parsed.checksum !== checksum) return undefined;
            if (checksumOf(parsed.text) !== checksum) return undefined;
            return parsed;
        } catch {
            return undefined;
        }
    }

    private async write(record: WorkRecord): Promise<void> {
        await this.ensureDir(this.dir(record.workId));
        await writeJsonAtomic(join(this.dir(record.workId), "work.json"), record, {
            indent: JSON_INDENT,
            secure: true,
        });
    }

    /**
     * Owner-only, like the files inside: results are the user's own model
     * output. `mkdir`'s mode is masked by umask and skipped for directories
     * that already exist, so each level under the root is chmod'ed explicitly.
     */
    private async ensureDir(dir: string): Promise<void> {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        for (let at = dir; at.startsWith(this.root); at = dirname(at)) {
            await restrictOwner(at, 0o700);
            if (at === this.root) break;
        }
    }

    private async readSnapshot(workId: string): Promise<WorkRecord | undefined> {
        if (await this.isDeleted(workId)) return undefined;
        return this.readSnapshotFile(workId);
    }

    private async readSnapshotFile(workId: string): Promise<WorkRecord | undefined> {
        const path = join(this.dir(workId), "work.json");
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                log.warn(`failed to read ${path}: ${String(err)}`);
            }
            return undefined;
        }
        try {
            const parsed = JSON.parse(raw) as WorkRecord;
            if (
                parsed.schemaVersion !== WORK_SCHEMA_VERSION ||
                parsed.workId !== workId ||
                !WORK_STATUSES.includes(parsed.status) ||
                !parsed.attempt?.attemptId
            ) {
                log.warn(`ignoring work snapshot with unexpected shape: ${path}`);
                return undefined;
            }
            return parsed;
        } catch (err) {
            log.warn(`malformed work snapshot ${path}: ${String(err)}`);
            return undefined;
        }
    }

    private withQueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
        assertSafeWorkId(id);
        return this.queue.run(id, operation);
    }
}
