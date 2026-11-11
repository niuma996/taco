import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { resolveWaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import type {
    WorkAttemptHandle,
    WorkOperationObservation,
    WorkOperationRef,
} from "./workOperationTypes.ts";
import type { WorkQueueStore } from "./workQueueStore.ts";
import { isQueueTerminal, type WorkQueueEntry } from "./workQueueTypes.ts";

const log = createLogger("sidecar.work.queue");
const MIN_WAKE_DELAY_MS = 50;
type QueueWorkStatus =
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "missing";
export interface WorkQueueAdmission {
    beforeAccept(): Promise<void>;
    afterAccept(): Promise<void>;
}
export interface WorkQueueBackend {
    prepare(entry: WorkQueueEntry): Promise<WorkAttemptHandle>;
    readWork(entry: WorkQueueEntry): Promise<QueueWorkStatus>;
    readAttempt?(entry: WorkQueueEntry): Promise<string | undefined>;
    inspect(ref: WorkOperationRef): Promise<WorkOperationObservation>;
    execute(entry: WorkQueueEntry, admission: WorkQueueAdmission): Promise<AgentMessage>;
    settle(
        entry: WorkQueueEntry,
        outcome: "completed" | "error" | "aborted",
        message?: AgentMessage,
        reason?: string,
    ): Promise<void>;
    cancel(entry: WorkQueueEntry): Promise<void>;
    /** Attach-time harness recovery remains the only driver of an already-open operation. */
    recover(entry: WorkQueueEntry): Promise<void>;
}

/** Durable FIFO admission, with independent lanes and bounded model execution. */
export class WorkQueue {
    private readonly epoch = randomUUID();
    private readonly active = new Map<
        string,
        { entry: WorkQueueEntry; observing: boolean; promise: Promise<void> }
    >();
    private readonly recoveryStarted = new Set<string>();
    private readonly listeners = new Map<string, Set<() => void>>();
    private stopped = true;
    private timer?: ReturnType<typeof setTimeout>;
    private timerAt = Infinity;
    private pumping?: Promise<void>;
    private readonly concurrency: number;
    private readonly workspaceConcurrency: number;
    private readonly pollMs: number;

    constructor(
        readonly store: WorkQueueStore,
        private readonly backend: WorkQueueBackend,
        options: { concurrency?: number; workspaceConcurrency?: number; pollMs?: number } = {},
    ) {
        this.concurrency = options.concurrency ?? 4;
        this.workspaceConcurrency = options.workspaceConcurrency ?? 2;
        this.pollMs = options.pollMs ?? 1000;
        if (
            ![this.concurrency, this.workspaceConcurrency, this.pollMs].every(
                (v) => Number.isInteger(v) && v > 0,
            )
        )
            throw new Error("invalid Work queue budget");
    }

    async start(): Promise<void> {
        this.stopped = false;
        await this.pump();
    }
    stop(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.timerAt = Infinity;
    }
    async whenIdle(): Promise<void> {
        while (this.active.size)
            await Promise.allSettled([...this.active.values()].map((value) => value.promise));
    }

    /** Retention pass for finished entries; failures must not stop scheduling. */
    async prune(): Promise<void> {
        const removed = await this.store.prune().catch((error) => {
            log.error("queue prune failed", { error: String(error) });
            return 0;
        });
        if (removed > 0) log.info("pruned finished queue entries", { count: removed });
    }

    /** Resolve when this intent reaches a terminal state or parks for a person. */
    async wait(queueId: string): Promise<WorkQueueEntry> {
        for (;;) {
            let ready!: () => void;
            const changed = new Promise<void>((resolve) => {
                ready = resolve;
            });
            const listeners = this.listeners.get(queueId) ?? new Set();
            listeners.add(ready);
            this.listeners.set(queueId, listeners);
            const current = await this.store.get(queueId);
            if (!current) {
                this.listeners.delete(queueId);
                throw new Error("Work queue entry disappeared");
            }
            if (current.status === "waiting" || isQueueTerminal(current.status)) {
                listeners.delete(ready);
                return current;
            }
            await changed;
        }
    }

    wake(delay = 0): void {
        if (this.stopped || this.timerAt <= Date.now() + delay) return;
        if (this.timer) clearTimeout(this.timer);
        this.timerAt = Date.now() + delay;
        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                this.timerAt = Infinity;
                void this.pump().catch((error) => {
                    log.error("queue pass failed", { error: String(error) });
                    this.wake(this.pollMs);
                });
            },
            Math.max(delay, MIN_WAKE_DELAY_MS),
        );
        this.timer.unref?.();
    }

    pump(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (this.pumping) return this.pumping;
        const pass = this.schedule();
        this.pumping = pass;
        void pass
            .finally(() => {
                if (this.pumping === pass) this.pumping = undefined;
            })
            .catch(() => undefined);
        return pass;
    }

    async cancel(queueId: string, revision: number) {
        const result = await this.store.cancel(queueId, revision);
        if (result.outcome === "accepted" && result.entry?.work) {
            await this.backend.cancel(result.entry);
            if (result.entry.status === "cancelled")
                await this.backend.settle(
                    result.entry,
                    "aborted",
                    undefined,
                    "cancelled before admission",
                );
        }
        this.wake();
        this.notify(queueId);
        return { outcome: result.outcome };
    }

    private lane(entry: WorkQueueEntry): string {
        return JSON.stringify([entry.workspace, entry.sessionId, entry.lane]);
    }
    private async schedule(): Promise<void> {
        const all = await this.store.listOpen();
        const heads = new Map<string, WorkQueueEntry>();
        for (const entry of all)
            if (!heads.has(this.lane(entry))) heads.set(this.lane(entry), entry);
        const occupied = new Map(
            all
                .filter((e) => e.status === "running" && e.operationAccepted)
                .map((e) => [e.queueId, e]),
        );
        for (const [id, task] of this.active) if (!task.observing) occupied.set(id, task.entry);
        for (const entry of heads.values()) {
            if (this.active.has(entry.queueId)) continue;
            const observing =
                entry.status === "waiting" ||
                (entry.status === "running" && entry.operationAccepted === true);
            if (
                !observing &&
                (occupied.size >= this.concurrency ||
                    [...occupied.values()].filter((e) => e.workspace === entry.workspace).length >=
                        this.workspaceConcurrency)
            )
                continue;
            if (!observing) occupied.set(entry.queueId, entry);
            const promise = this.process(entry)
                .then((progress) => this.wake(progress ? 0 : this.pollMs))
                .catch((error) => {
                    log.error("queue entry could not be reconciled", {
                        queueId: entry.queueId,
                        error: String(error),
                    });
                    this.wake(this.pollMs);
                })
                .finally(() => {
                    this.active.delete(entry.queueId);
                    this.notify(entry.queueId);
                });
            this.active.set(entry.queueId, { entry, observing, promise });
        }
        if (all.length) this.wake(this.pollMs);
    }

    private notify(queueId: string): void {
        const listeners = this.listeners.get(queueId);
        this.listeners.delete(queueId);
        for (const resolve of listeners ?? []) resolve();
    }

    private async process(snapshot: WorkQueueEntry): Promise<boolean> {
        let entry = await this.store.claim(snapshot.queueId, this.epoch);
        if (!entry) return true;
        const save = (update: (value: WorkQueueEntry) => WorkQueueEntry | undefined) =>
            this.store.updateOwned(snapshot.queueId, this.epoch, update);
        const fail = async (reason: string) => {
            if (entry?.work) await this.backend.settle(entry, "error", undefined, reason);
            await save((value) => ({ ...value, status: "failed", reason }));
            return true;
        };
        if (!entry.operation) throw new Error("claimed queue entry has no operation");
        if (entry.cancelRequestedAt !== undefined) {
            if (entry.work) {
                await this.backend.cancel(entry);
                await this.backend.settle(entry, "aborted", undefined, "cancelled by the user");
            }
            await save((value) => ({ ...value, status: "cancelled" }));
            return true;
        }
        if (entry.deadlineAt <= Date.now() && !entry.operationAccepted)
            return fail("queue waiting deadline exceeded");
        if (entry.work) {
            const attemptId = await this.backend.readAttempt?.(entry);
            if (attemptId !== undefined && attemptId !== entry.work.attemptId) {
                // An explicit answer owns a fresh attempt and operation. This queue
                // entry belongs only to the old, already-settled waiting operation.
                await save((value) => ({ ...value, status: "completed" }));
                return true;
            }
            const state = await this.backend.readWork(entry);
            if (
                state === "completed" ||
                state === "failed" ||
                state === "cancelled" ||
                state === "interrupted"
            ) {
                await this.backend.settle(
                    entry,
                    state === "completed"
                        ? "completed"
                        : state === "interrupted"
                          ? "error"
                          : state === "cancelled"
                            ? "aborted"
                            : "error",
                    undefined,
                    entry.reason,
                );
                await save((value) => ({
                    ...value,
                    status: state === "interrupted" ? "failed" : state,
                }));
                return true;
            }
            if (state === "waiting") {
                if (entry.status !== "waiting")
                    await save((value) => ({ ...value, status: "waiting" }));
                return false;
            }
            if (state === "missing") return fail("queued Work record is missing");
        }
        // Inspect before admission, including a crash before the Work link was saved.
        const observed = await this.backend.inspect(entry.operation);
        if (observed.kind === "unknown") return false;
        if (!entry.work) {
            let handle: WorkAttemptHandle;
            try {
                handle = await this.backend.prepare(entry);
            } catch (error) {
                if ((error as { code?: unknown }).code === "legacy_work")
                    return fail("existing Work retains its legacy queue semantics");
                throw error;
            }
            entry = await save((value) => ({ ...value, work: handle }));
            if (!entry) return false;
        }
        if (observed.kind === "settled") {
            await this.finish(entry, observed.outcome, observed.message, observed.reason);
            return true;
        }
        if (observed.kind === "open") {
            await save((value) => ({ ...value, status: "running", operationAccepted: true }));
            if (!this.recoveryStarted.has(entry.queueId)) {
                await this.backend.recover(entry);
                this.recoveryStarted.add(entry.queueId);
            }
            return false;
        }
        if (entry.operationAccepted)
            return fail("accepted operation cannot be confirmed; execution was not repeated");
        try {
            const result = await this.backend.execute(entry, {
                beforeAccept: async () => {
                    const current = await this.store.get(snapshot.queueId);
                    if (
                        !current ||
                        current.driverEpoch !== this.epoch ||
                        isQueueTerminal(current.status) ||
                        current.cancelRequestedAt !== undefined
                    )
                        throw Object.assign(new Error("queue admission cancelled"), {
                            code: "aborted",
                        });
                },
                afterAccept: async () => {
                    let current: WorkQueueEntry | undefined;
                    try {
                        current = await save((value) => ({
                            ...value,
                            status: "running",
                            operationAccepted: true,
                        }));
                    } catch (error) {
                        throw Object.assign(new Error("queue admission state needs recovery"), {
                            code: "queue_recovery_required",
                            cause: error,
                        });
                    }
                    if (!current || current.cancelRequestedAt !== undefined)
                        await this.backend.cancel(current ?? entry);
                },
            });
            await this.finish(entry, "completed", result);
            return true;
        } catch (error) {
            const current = await this.store.get(snapshot.queueId);
            if (!current || current.driverEpoch !== this.epoch) return false;
            const code = (error as { code?: string }).code;
            // The harness accepted the operation but its queue projection could
            // not be written. Inspect the same operation on the next pass; never
            // settle it as failed or invoke a replacement while this is ambiguous.
            if (code === "queue_recovery_required") return false;
            if (
                code === "session_busy" &&
                !current.operationAccepted &&
                current.cancelRequestedAt === undefined
            ) {
                await save((value) => ({ ...value, status: "queued" }));
                return false;
            }
            await this.finish(
                current,
                code === "aborted" || current.cancelRequestedAt !== undefined ? "aborted" : "error",
                undefined,
                code ?? "execution failed",
            );
            return true;
        }
    }

    private async finish(
        entry: WorkQueueEntry,
        outcome: "completed" | "error" | "aborted",
        message?: AgentMessage,
        reason?: string,
    ): Promise<void> {
        const current = await this.store.get(entry.queueId);
        if (!current || current.driverEpoch !== this.epoch || isQueueTerminal(current.status))
            return;
        if (current.cancelRequestedAt !== undefined) outcome = "aborted";
        await this.backend.settle(current, outcome, message, reason);
        const waiting =
            outcome === "completed" && resolveWaitingInteraction(message, current.sessionId);
        await this.store.updateOwned(entry.queueId, this.epoch, (value) => ({
            ...value,
            status: waiting
                ? "waiting"
                : outcome === "completed"
                  ? "completed"
                  : outcome === "aborted"
                    ? "cancelled"
                    : "failed",
            reason,
        }));
    }
}
