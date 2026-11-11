import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { writeJsonAtomic } from "../store/atomicFile.ts";
import { type IndexEntry, readIndex, sameStamp, stampOf, writeIndex } from "../store/indexFile.ts";
import { SerialChain } from "../store/serial.ts";
import {
    isQueueTerminal,
    type QueueCancelOutcome,
    type WorkQueueEntry,
    type WorkQueueIntent,
} from "./workQueueTypes.ts";

const SAFE_QUEUE_ID = /^q-[a-f0-9]{32}$/;
const MAX_WAIT_MS = 24 * 60 * 60_000;
const QUEUE_STATUSES = [
    "queued",
    "admitting",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
] as const;

/** What `enqueue` needs for admission without parsing a record's payload. */
interface QueueSummary {
    readonly sequence: number;
    readonly status: WorkQueueEntry["status"];
}

function isQueueStatus(value: unknown): value is WorkQueueEntry["status"] {
    return typeof value === "string" && QUEUE_STATUSES.some((status) => status === value);
}

function isQueueSummary(value: unknown): value is QueueSummary {
    if (typeof value !== "object" || value === null) return false;
    const summary = value as Record<string, unknown>;
    return Number.isInteger(summary.sequence) && isQueueStatus(summary.status);
}

/** One daemon writes this ledger. In-memory serialization never substitutes for operation recovery. */
export class WorkQueueStore {
    private readonly chain = new SerialChain();
    constructor(
        private readonly root: string,
        private readonly pendingLimit = 1024,
    ) {}

    enqueue(
        intent: WorkQueueIntent,
        now = Date.now(),
    ): Promise<{ entry: WorkQueueEntry; created: boolean }> {
        return this.chain.run(async () => {
            if (
                !intent.workspace ||
                !intent.sessionId ||
                !intent.sourceEventId ||
                intent.lane !== "main" ||
                (intent.kind === "scheduled" && !intent.payload.text.trim()) ||
                (intent.kind === "inbound" &&
                    (!intent.deliveryTarget || !intent.sourceMemberIds?.length))
            )
                throw new Error("invalid Work queue intent");
            const queueId = `q-${createHash("sha256")
                .update(JSON.stringify([intent.workspace, intent.sourceEventId]))
                .digest("hex")
                .slice(0, 32)}`;
            const existing = await this.read(queueId);
            if (existing) return { entry: existing, created: false };
            const summaries = await this.summaries();
            const open = [...summaries.values()].filter((s) => !isQueueTerminal(s.status)).length;
            if (open >= this.pendingLimit) throw new Error("Work queue is full");
            const sequence =
                [...summaries.values()].reduce((max, s) => Math.max(max, s.sequence), 0) + 1;
            const deadlineAt = intent.deadlineAt ?? now + MAX_WAIT_MS;
            if (!Number.isFinite(deadlineAt)) throw new Error("invalid Work queue deadline");
            const entry: WorkQueueEntry = {
                ...intent,
                schemaVersion: 1,
                queueId,
                sequence,
                revision: 0,
                status: "queued",
                enqueuedAt: now,
                updatedAt: now,
                deadlineAt,
            };
            await this.write(entry);
            return { entry, created: true };
        });
    }

    get(id: string): Promise<WorkQueueEntry | undefined> {
        return this.chain.run(() => this.read(id));
    }
    list(): Promise<WorkQueueEntry[]> {
        return this.chain.run(() => this.readAll());
    }

    claim(id: string, epoch: string): Promise<WorkQueueEntry | undefined> {
        return this.chain.run(async () => {
            const current = await this.read(id);
            if (!current || isQueueTerminal(current.status)) return undefined;
            if (current.driverEpoch === epoch && current.status !== "queued") return current;
            return this.save({
                ...current,
                driverEpoch: epoch,
                status: current.status === "queued" ? "admitting" : current.status,
                operation: current.operation ?? {
                    workspace: current.workspace,
                    sessionId: current.sessionId,
                    lane: current.lane,
                    operationId: randomUUID(),
                },
            });
        });
    }

    updateOwned(
        id: string,
        epoch: string,
        update: (entry: WorkQueueEntry) => WorkQueueEntry | undefined,
    ): Promise<WorkQueueEntry | undefined> {
        return this.chain.run(async () => {
            const entry = await this.read(id);
            if (!entry || entry.driverEpoch !== epoch || isQueueTerminal(entry.status))
                return undefined;
            const next = update(entry);
            if (!next) return undefined;
            if (
                next.queueId !== id ||
                next.sourceEventId !== entry.sourceEventId ||
                next.workspace !== entry.workspace ||
                next.sessionId !== entry.sessionId ||
                next.lane !== entry.lane ||
                next.sequence !== entry.sequence
            )
                throw new Error("Work queue identity is immutable");
            return this.save(next);
        });
    }

    cancel(
        id: string,
        revision: number,
        now = Date.now(),
    ): Promise<{ outcome: QueueCancelOutcome; entry?: WorkQueueEntry }> {
        return this.chain.run(async () => {
            const entry = await this.read(id);
            if (!entry) return { outcome: "not_found" };
            if (entry.cancelRequestedAt !== undefined) return { outcome: "accepted", entry };
            if (isQueueTerminal(entry.status)) return { outcome: "not_running", entry };
            if (entry.revision !== revision) return { outcome: "revision_mismatch", entry };
            return {
                outcome: "accepted",
                entry: await this.save({
                    ...entry,
                    cancelRequestedAt: now,
                    status: entry.status === "queued" ? "cancelled" : entry.status,
                }),
            };
        });
    }

    private path(id: string): string {
        if (!SAFE_QUEUE_ID.test(id)) throw new Error("unsafe Work queue id");
        return join(this.root, `${id}.json`);
    }
    private async read(id: string): Promise<WorkQueueEntry | undefined> {
        const path = this.path(id);
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
        const entry = JSON.parse(raw) as WorkQueueEntry;
        if (
            entry?.schemaVersion !== 1 ||
            entry.queueId !== id ||
            !Number.isInteger(entry.revision) ||
            !Number.isInteger(entry.sequence) ||
            !isQueueStatus(entry.status)
        )
            throw new Error("unrecognized Work queue snapshot");
        return entry;
    }
    private async readAll(): Promise<WorkQueueEntry[]> {
        const ids = await this.ids();
        const entries = await Promise.all(ids.map((id) => this.read(id)));
        return entries
            .filter((e): e is WorkQueueEntry => e !== undefined)
            .sort((a, b) => a.sequence - b.sequence);
    }

    /** Live record ids on disk; the index never introduces or removes records. */
    private async ids(): Promise<string[]> {
        const files = await readdir(this.root).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        });
        return files
            .filter((f) => f.endsWith(".json") && SAFE_QUEUE_ID.test(f.slice(0, -5)))
            .map((f) => f.slice(0, -5));
    }

    /**
     * Per-record `{sequence, status}` for admission. A record whose file
     * changed since the index was written is re-read, and a missing or stale
     * index falls back to parsing every record. The index is written back so
     * the next enqueue sees one refresh instead of a rescan.
     */
    private async summaries(): Promise<Map<string, QueueSummary>> {
        const ids = await this.ids();
        const cached = await readIndex<QueueSummary>(
            this.root,
            (id) => SAFE_QUEUE_ID.test(id),
            isQueueSummary,
        );
        const result = new Map<string, QueueSummary>();
        const next: Record<string, IndexEntry<QueueSummary>> = {};
        for (const id of ids) {
            const path = this.path(id);
            const stamp = await stampOf(path);
            if (!stamp) continue;
            const previous = cached?.[id];
            let summary: QueueSummary;
            if (previous && sameStamp(previous.stamp, stamp)) {
                summary = previous.summary;
            } else {
                const entry = await this.read(id);
                if (!entry) continue;
                summary = { sequence: entry.sequence, status: entry.status };
            }
            result.set(id, summary);
            next[id] = { stamp, summary };
        }
        await writeIndex(this.root, next).catch(() => undefined);
        return result;
    }

    private async save(entry: WorkQueueEntry): Promise<WorkQueueEntry> {
        const next = { ...entry, revision: entry.revision + 1, updatedAt: Date.now() };
        await this.write(next);
        return next;
    }
    private async write(entry: WorkQueueEntry): Promise<void> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await restrictOwner(this.root, 0o700);
        await writeJsonAtomic(this.path(entry.queueId), entry, { secure: true });
    }
}
