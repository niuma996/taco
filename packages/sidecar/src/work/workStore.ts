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

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionTarget } from "@taco-ai/protocol";
import { WORK_STATUSES } from "@taco-ai/protocol";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";
import { isTerminal, WORK_SCHEMA_VERSION, type WorkRecord } from "./workTypes.ts";

const log = createLogger("sidecar.work.store");

const JSON_INDENT = 2;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSafeWorkId(id: string): boolean {
    return SAFE_ID.test(id);
}

export function assertSafeWorkId(id: string): void {
    if (!isSafeWorkId(id)) throw new Error(`unsafe work id: ${JSON.stringify(id)}`);
}

/** Stable id for one source event, so a repeat launch maps to the same Work. */
export function workIdForSource(sourceEventId: string): string {
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

export class WorkStore {
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly root: string) {}

    private dir(workId: string): string {
        assertSafeWorkId(workId);
        return join(this.root, workId);
    }

    /**
     * Create the Work, or return the one that already exists for this source.
     * `created` tells the caller whether it won the race.
     */
    async createIfAbsent(record: WorkRecord): Promise<{ record: WorkRecord; created: boolean }> {
        return this.withQueue(record.workId, async () => {
            if (await this.isDeleted(record.workId)) throw new Error("work source was deleted");
            const existing = await this.readSnapshot(record.workId);
            if (existing) return { record: existing, created: false };
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
        });
    }

    async get(workId: string): Promise<WorkRecord | undefined> {
        assertSafeWorkId(workId);
        return this.readSnapshot(workId);
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
            if (!e.isDirectory() || !isSafeWorkId(e.name)) continue;
            const record = await this.readSnapshot(e.name);
            if (record) records.push(record);
        }
        return records.sort((a, b) => b.createdAt - a.createdAt);
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
        await this.atomicWrite(path, JSON.stringify({ invalidated: true }));
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
            await this.atomicWrite(
                join(dir, `${workId}.json`),
                JSON.stringify({ workId, deletedAt: Date.now() }),
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
        await this.atomicWrite(final, JSON.stringify(stored, null, JSON_INDENT));
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
        await this.atomicWrite(
            join(this.dir(record.workId), "work.json"),
            JSON.stringify(record, null, JSON_INDENT),
        );
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

    private async atomicWrite(final: string, body: string): Promise<void> {
        const tmp = `${final}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(tmp, body, "utf8");
            await restrictOwner(tmp);
            await rename(tmp, final);
        } finally {
            await unlink(tmp).catch(() => undefined);
        }
    }

    private async readSnapshot(workId: string): Promise<WorkRecord | undefined> {
        if (await this.isDeleted(workId)) return undefined;
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

    private async withQueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
        assertSafeWorkId(id);
        const previous = this.queues.get(id) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.queues.set(id, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (this.queues.get(id) === tail) this.queues.delete(id);
        }
    }
}
