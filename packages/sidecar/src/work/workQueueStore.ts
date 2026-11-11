import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { restrictOwner } from "../lib/fsPermissions.ts";
import { writeJsonAtomic } from "../store/atomicFile.ts";
import { SerialChain } from "../store/serial.ts";
import {
    isQueueTerminal,
    type QueueCancelOutcome,
    type WorkQueueEntry,
    type WorkQueueIntent,
} from "./workQueueTypes.ts";

const SAFE_QUEUE_ID = /^q-[a-f0-9]{32}$/;
const MAX_WAIT_MS = 24 * 60 * 60_000;

/** Finished entries age out; without a cap the directory grows for the daemon's lifetime. */
export const QUEUE_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const QUEUE_RETENTION_COUNT = 500;

/** One daemon writes this ledger. In-memory serialization never substitutes for operation recovery. */
export class WorkQueueStore {
    private readonly chain = new SerialChain();
    /** Live ids and the next sequence, seeded once per process from disk. */
    private state?: { open: Set<string>; nextSequence: number };
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
            const state = await this.derive();
            if (state.open.size >= this.pendingLimit) throw new Error("Work queue is full");
            const deadlineAt = intent.deadlineAt ?? now + MAX_WAIT_MS;
            if (!Number.isFinite(deadlineAt)) throw new Error("invalid Work queue deadline");
            const entry: WorkQueueEntry = {
                ...intent,
                schemaVersion: 1,
                queueId,
                sequence: state.nextSequence,
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

    /**
     * The scheduler's per-pass read. Only live entries are re-read, so a large
     * ledger of finished ones costs nothing until `prune` removes them.
     */
    listOpen(): Promise<WorkQueueEntry[]> {
        return this.chain.run(async () => {
            const state = await this.derive();
            const open: WorkQueueEntry[] = [];
            for (const id of state.open) {
                const entry = await this.read(id);
                if (!entry || isQueueTerminal(entry.status)) {
                    state.open.delete(id);
                    continue;
                }
                open.push(entry);
            }
            return open.sort((a, b) => a.sequence - b.sequence);
        });
    }

    /** Drop finished entries past the age window or beyond the newest `QUEUE_RETENTION_COUNT`. */
    prune(now = Date.now()): Promise<number> {
        return this.chain.run(async () => {
            const state = await this.derive();
            const finished = (await this.readAll())
                .filter((entry) => isQueueTerminal(entry.status))
                .sort((a, b) => b.updatedAt - a.updatedAt);
            let removed = 0;
            for (const [index, entry] of finished.entries()) {
                if (index < QUEUE_RETENTION_COUNT && now - entry.updatedAt <= QUEUE_RETENTION_MS)
                    continue;
                await rm(this.path(entry.queueId), { force: true });
                state.open.delete(entry.queueId);
                removed++;
            }
            return removed;
        });
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
            ![
                "queued",
                "admitting",
                "running",
                "waiting",
                "completed",
                "failed",
                "cancelled",
            ].includes(entry.status)
        )
            throw new Error("unrecognized Work queue snapshot");
        return entry;
    }
    private async readAll(): Promise<WorkQueueEntry[]> {
        const files = await readdir(this.root).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        });
        const entries = await Promise.all(
            files
                .filter((f) => f.endsWith(".json") && SAFE_QUEUE_ID.test(f.slice(0, -5)))
                .map((f) => this.read(f.slice(0, -5))),
        );
        return entries
            .filter((e): e is WorkQueueEntry => e !== undefined)
            .sort((a, b) => a.sequence - b.sequence);
    }
    private async derive(): Promise<{ open: Set<string>; nextSequence: number }> {
        if (!this.state) {
            const all = await this.readAll();
            this.state = {
                open: new Set(
                    all.filter((entry) => !isQueueTerminal(entry.status)).map((e) => e.queueId),
                ),
                nextSequence: all.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1,
            };
        }
        return this.state;
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
        if (!this.state) return;
        if (isQueueTerminal(entry.status)) this.state.open.delete(entry.queueId);
        else this.state.open.add(entry.queueId);
        this.state.nextSequence = Math.max(this.state.nextSequence, entry.sequence + 1);
    }
}
