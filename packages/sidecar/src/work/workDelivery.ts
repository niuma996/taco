/**
 * Delivers a settled Work's notice to the IM peer who started it.
 *
 * One deliverer per Work, chunks strictly in order, and the count of
 * confirmed chunks is persisted after each one. A restart resumes from the
 * next unconfirmed chunk rather than from the top, so a long answer split in
 * five does not arrive twice just because the process died after the third.
 *
 * Semantics are at-least-once. If the platform accepts a chunk and the process
 * dies before `confirmedChunks` is written, that one chunk is sent again.
 * That is the price of not losing the message, and it is bounded to one chunk.
 */

import { type ImRoute, WORK_RETRYABLE_DELIVERY_STATUSES } from "@taco-ai/protocol";
import type { SendOutboundResult } from "../channels/types.ts";
import { createLogger } from "../lib/logger.ts";
import type { WorkStore } from "./workStore.ts";
import type { DeliveryStatus, WorkDelivery, WorkRecord } from "./workTypes.ts";

const log = createLogger("sidecar.work.delivery");

/** Retry delays, in order. An index past the end repeats the last one. */
export const DELIVERY_BACKOFF_MS: readonly number[] = [
    5_000,
    30_000,
    2 * 60_000,
    10 * 60_000,
    30 * 60_000,
];

/** After this many counted failures the delivery stops retrying on its own. */
export const MAX_DELIVERY_ATTEMPTS = 10;

/** A notice older than this when it would be sent is dropped, not delivered. */
export const DELIVERY_EXPIRY_MS = 6 * 60 * 60_000;

/** How long the parent model gets to write the notice before the template does. */
export const PARENT_REPLY_GRACE_MS = 3 * 60_000;

/**
 * How often an unavailable channel is probed again. Reconnect is still the
 * event that matters, but an auth refusal or an expired bot session does not
 * produce a connection transition, so waiting for one would strand the notice
 * until expiry.
 */
export const UNAVAILABLE_RETRY_MS = 5 * 60_000;

/**
 * How long a notice run that is still going may hold the template back. Longer
 * than the permission broker's 10-minute timeout, so a run waiting on the
 * peer's approval gets to finish instead of being cut off by its own notice.
 */
export const PARENT_REPLY_MAX_WAIT_MS = 15 * 60_000;

/** Lets the deliverer see notice runs without owning them. */
export interface NoticeCapture {
    /** A notice run for this Work is still writing its message. */
    isCapturing(workId: string): boolean;
    /** The template is being frozen: stop holding that run's text from the channel. */
    stopCapturing(workId: string): void;
}

/** How many deliveries `resume()` sends at once. */
const RESUME_CONCURRENCY = 8;

/** Jitter keeps a burst of Works that failed together from retrying together. */
const JITTER_RATIO = 0.2;

export interface DeliverySender {
    sendText(channelId: string, route: ImRoute, text: string): Promise<SendOutboundResult>;
}

export interface DeliveryClock {
    now(): number;
    /** Schedule `fn` after `ms`; returns a cancel function. */
    setTimer(fn: () => void, ms: number): () => void;
    /** 0..1, injected so tests do not depend on Math.random. */
    random(): number;
}

export const systemClock: DeliveryClock = {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
    },
    random: () => Math.random(),
};

export function backoffDelay(attempt: number, random: number): number {
    const index = Math.min(attempt, DELIVERY_BACKOFF_MS.length - 1);
    const base = DELIVERY_BACKOFF_MS[index] ?? 0;
    const spread = base * JITTER_RATIO;
    return Math.round(base - spread + random * spread * 2);
}

/** Whether a delivery is still waiting to send something. */
export function isOpen(delivery: WorkDelivery | undefined): delivery is WorkDelivery {
    return delivery !== undefined && delivery.status === "pending";
}

/** The moment a notice's six hours start: the last manual retry, else the end of the run. */
function expiryBase(work: WorkRecord, delivery: WorkDelivery): number | undefined {
    return delivery.retriedAt ?? work.endedAt;
}

/** Delivery states a person can send again. */
const RETRYABLE: ReadonlySet<DeliveryStatus> = new Set(WORK_RETRYABLE_DELIVERY_STATUSES);

export class WorkDeliverer {
    private readonly running = new Set<string>();
    /** Triggers that arrived while a delivery was running; re-run once it ends. */
    private readonly rerun = new Set<string>();
    private readonly timers = new Map<string, () => void>();
    private readonly idleWaiters = new Map<string, Array<() => void>>();
    private stopped = false;

    constructor(
        private readonly store: WorkStore,
        private readonly sender: DeliverySender,
        private readonly clock: DeliveryClock = systemClock,
        private readonly onChange: (workId: string) => void = () => undefined,
        private readonly capture?: NoticeCapture,
    ) {}

    /**
     * Run the delivery for one Work now. A Work already being delivered is never
     * sent twice at once, but a trigger that arrives mid-run is not dropped
     * either: it is replayed once the current pass ends. Without that, a manual
     * retry landing while the previous pass was finishing would flip the record
     * to pending and then be swallowed by the running guard, leaving the notice
     * to sit until its six-hour expiry.
     */
    async deliver(workId: string): Promise<void> {
        if (this.stopped) return;
        if (this.running.has(workId)) {
            this.rerun.add(workId);
            return;
        }
        this.running.add(workId);
        this.cancelTimer(workId);
        try {
            await this.run(workId);
        } catch (e) {
            // Store I/O or a sender that throws must not surface as an unhandled
            // rejection from a timer; the next trigger retries the Work.
            log.error("work delivery pass failed", { workId, error: String(e) });
        } finally {
            this.running.delete(workId);
            for (const resolve of this.idleWaiters.get(workId) ?? []) resolve();
            this.idleWaiters.delete(workId);
        }
        if (this.rerun.delete(workId)) void this.deliver(workId);
    }

    /**
     * Send a notice again on a person's request. Only a delivery that gave up
     * can be retried; anything else is either still going or already done, and
     * a second send would only duplicate it. The frozen message is kept, and so
     * is the count of chunks the platform already accepted, so a long answer
     * resumes instead of starting over.
     */
    async retry(workId: string): Promise<"accepted" | "not_found" | "not_retryable"> {
        const now = this.clock.now();
        // The verdict is decided inside the serialized mutation, from the state
        // that mutation saw. Two simultaneous callers queue behind each other:
        // the first flips the delivery to pending and the second finds it no
        // longer retryable. Inferring the winner afterwards from the stored
        // record cannot tell them apart.
        const seen: { verdict: "accepted" | "not_found" | "not_retryable" } = {
            verdict: "not_found",
        };
        await this.store.mutate(workId, (current) => {
            const d = current.delivery;
            if (!d) {
                // The Work exists but never queued a notice (its driver died
                // before settling, or it had no IM target). That is "nothing to
                // resend", not a missing Work.
                seen.verdict = "not_retryable";
                return undefined;
            }
            if (!RETRYABLE.has(d.status)) {
                seen.verdict = "not_retryable";
                return undefined;
            }
            seen.verdict = "accepted";
            return {
                ...current,
                updatedAt: now,
                delivery: {
                    ...d,
                    status: "pending",
                    attempts: 0,
                    nextAttemptAt: undefined,
                    lastError: undefined,
                    retriedAt: now,
                },
            };
        });
        if (seen.verdict === "accepted") {
            this.onChange(workId);
            void this.deliver(workId);
        }
        return seen.verdict;
    }

    /**
     * Pick up every Work with a pending delivery. Called at startup and when a
     * channel starts. Batched: a ledger with hundreds of owed notices must not
     * open hundreds of concurrent sends against one channel.
     */
    async resume(): Promise<void> {
        const pending = (await this.store.list()).filter((w) => isOpen(w.delivery));
        for (let i = 0; i < pending.length; i += RESUME_CONCURRENCY) {
            await Promise.all(
                pending.slice(i, i + RESUME_CONCURRENCY).map((w) => this.deliver(w.workId)),
            );
        }
    }

    stop(): void {
        this.stopped = true;
        this.rerun.clear();
        for (const cancel of this.timers.values()) cancel();
        this.timers.clear();
    }

    /** Tombstone first; an already-started platform send must finish before files are removed. */
    async forget(workId: string): Promise<void> {
        this.cancelTimer(workId);
        this.rerun.delete(workId);
        if (!this.running.has(workId)) return;
        await new Promise<void>((resolve) => {
            const waiters = this.idleWaiters.get(workId) ?? [];
            waiters.push(resolve);
            this.idleWaiters.set(workId, waiters);
        });
    }

    private async run(workId: string): Promise<void> {
        for (;;) {
            if (this.stopped) return;
            const work = await this.store.get(workId);
            const delivery = work?.delivery;
            if (!work || !isOpen(delivery)) return;

            const now = this.clock.now();
            if (!delivery.chunks) {
                // The parent model is still expected to write the notice. Wait
                // out the grace period, then freeze the template.
                const until = delivery.awaitingParentReplyUntil;
                if (until !== undefined && now < until) {
                    this.arm(workId, until - now);
                    return;
                }
                // A run that is still writing gets more time: freezing now would
                // throw its reply away. Its own end freezes the message and
                // calls `deliver`, so the timer only guards the outer bound.
                const longest = delivery.createdAt + PARENT_REPLY_MAX_WAIT_MS;
                if (this.capture?.isCapturing(workId) && now < longest) {
                    this.arm(workId, longest - now);
                    return;
                }
                // Past that bound the reply cannot become the message any more;
                // let it reach the channel live rather than vanish.
                this.capture?.stopCapturing(workId);
                await this.freezeTemplate(work);
                continue;
            }

            if (delivery.nextAttemptAt !== undefined && now < delivery.nextAttemptAt) {
                this.arm(workId, delivery.nextAttemptAt - now);
                return;
            }
            const startedAt = expiryBase(work, delivery);
            if (startedAt !== undefined && now - startedAt > DELIVERY_EXPIRY_MS) {
                await this.finish(workId, "expired", "notice too old to send");
                return;
            }
            if (delivery.confirmedChunks >= delivery.chunks.length) {
                await this.finish(workId, "confirmed");
                return;
            }

            const next = delivery.chunks[delivery.confirmedChunks];
            if (next === undefined) return;
            const result = await this.sender.sendText(
                delivery.target.channelId,
                { ...delivery.target },
                next,
            );
            if (await this.apply(workId, result)) continue;

            // A failure that will be retried must wake itself up. Without this the
            // backoff only ever fires if some other trigger happens to call
            // `deliver` again, and a single dropped message stays dropped.
            const after = (await this.store.get(workId))?.delivery;
            if (isOpen(after) && after.nextAttemptAt !== undefined) {
                this.arm(workId, after.nextAttemptAt - this.clock.now());
            } else if (isOpen(after)) {
                // Unavailable: probe again on a slow timer. Reconnect is the
                // better trigger when it comes, but a platform refusal does not
                // move the connection state, and waiting only for the expiry
                // deadline would leave the user silent for six hours.
                const base = expiryBase(work, after);
                const untilExpiry =
                    base === undefined
                        ? UNAVAILABLE_RETRY_MS
                        : base + DELIVERY_EXPIRY_MS + 1 - this.clock.now();
                this.arm(workId, Math.min(UNAVAILABLE_RETRY_MS, untilExpiry));
            }
            return;
        }
    }

    /** Record one send result. Returns whether the loop should send the next chunk. */
    private async apply(workId: string, result: SendOutboundResult): Promise<boolean> {
        switch (result.kind) {
            case "confirmed":
                await this.mutateDelivery(workId, (d) => ({
                    ...d,
                    confirmedChunks: d.confirmedChunks + 1,
                    attempts: 0,
                    nextAttemptAt: undefined,
                    lastError: undefined,
                }));
                return true;
            case "unavailable":
                // Not counted: the channel being down is not this message's
                // fault, and burning attempts on it would exhaust the budget
                // during an outage that ends by itself. It is probed on a slow
                // timer, and `resume()` on reconnect retries immediately; expiry
                // still bounds the total wait.
                await this.mutateDelivery(workId, (d) =>
                    // An outage that repeats the same code changes nothing; a
                    // write and a push every retry tick would be noise.
                    d.lastError === result.code ? d : { ...d, lastError: result.code },
                );
                return false;
            case "retryable": {
                const updated = await this.mutateDelivery(workId, (d) => {
                    const attempts = d.attempts + 1;
                    const delay = Math.max(
                        result.retryAfterMs ?? 0,
                        backoffDelay(attempts - 1, this.clock.random()),
                    );
                    return {
                        ...d,
                        attempts,
                        lastError: result.code,
                        nextAttemptAt: this.clock.now() + delay,
                    };
                });
                if (updated && updated.attempts >= MAX_DELIVERY_ATTEMPTS) {
                    await this.finish(workId, "retryExhausted", result.code);
                }
                return false;
            }
            case "permanentFailure":
                await this.finish(workId, "permanentFailure", result.code);
                return false;
        }
    }

    private async freezeTemplate(work: WorkRecord): Promise<void> {
        await this.mutateDelivery(work.workId, (d) => {
            if (d.chunks) return d;
            return {
                ...d,
                chunks: d.templateChunks ?? [],
                source: "template",
                awaitingParentReplyUntil: undefined,
            };
        });
    }

    private async finish(workId: string, status: DeliveryStatus, error?: string): Promise<void> {
        await this.mutateDelivery(workId, (d) =>
            isOpen(d)
                ? {
                      ...d,
                      status,
                      nextAttemptAt: undefined,
                      ...(error ? { lastError: error } : {}),
                  }
                : d,
        );
        log.info("delivery finished", { workId, status, ...(error ? { error } : {}) });
    }

    private async mutateDelivery(
        workId: string,
        update: (delivery: WorkDelivery) => WorkDelivery,
    ): Promise<WorkDelivery | undefined> {
        const res = await this.store.mutate(workId, (work) => {
            if (!work.delivery) return undefined;
            const updated = update(work.delivery);
            if (updated === work.delivery) return undefined;
            return { ...work, updatedAt: this.clock.now(), delivery: updated };
        });
        if (!res?.changed) return undefined;
        this.onChange(workId);
        return res.record.delivery;
    }

    private arm(workId: string, ms: number): void {
        this.cancelTimer(workId);
        this.timers.set(
            workId,
            this.clock.setTimer(
                () => {
                    this.timers.delete(workId);
                    void this.deliver(workId);
                },
                Math.max(ms, 1),
            ),
        );
    }

    private cancelTimer(workId: string): void {
        this.timers.get(workId)?.();
        this.timers.delete(workId);
    }
}
