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

import type { ImRoute } from "@taco-ai/protocol";
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

export class WorkDeliverer {
    private readonly running = new Set<string>();
    private readonly timers = new Map<string, () => void>();
    private stopped = false;

    constructor(
        private readonly store: WorkStore,
        private readonly sender: DeliverySender,
        private readonly clock: DeliveryClock = systemClock,
        private readonly onChange: (workId: string) => void = () => undefined,
        private readonly capture?: NoticeCapture,
    ) {}

    /**
     * Run the delivery for one Work now. A Work already being delivered is left
     * alone, so calling this from several triggers (settle, channel start,
     * manual retry) never produces two senders.
     */
    async deliver(workId: string): Promise<void> {
        if (this.stopped || this.running.has(workId)) return;
        this.running.add(workId);
        this.cancelTimer(workId);
        try {
            await this.run(workId);
        } finally {
            this.running.delete(workId);
        }
    }

    /** Pick up every Work with a pending delivery. Called at startup and when a channel starts. */
    async resume(): Promise<void> {
        const all = await this.store.list();
        await Promise.all(all.filter((w) => isOpen(w.delivery)).map((w) => this.deliver(w.workId)));
    }

    stop(): void {
        this.stopped = true;
        for (const cancel of this.timers.values()) cancel();
        this.timers.clear();
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
            if (work.endedAt !== undefined && now - work.endedAt > DELIVERY_EXPIRY_MS) {
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
            } else if (isOpen(after) && work.endedAt !== undefined) {
                // Unavailable: reconnect is what resends, but if it never comes
                // the notice must still expire, or it stays pending — and
                // unprunable — forever. One timer at the deadline, no attempt.
                this.arm(workId, work.endedAt + DELIVERY_EXPIRY_MS + 1 - this.clock.now());
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
                // Not counted and not timed: the channel being down is not this
                // message's fault, and burning attempts on it would exhaust the
                // budget during an outage that ends by itself. The controller
                // calls `resume()` when the channel reports connected, which is
                // the signal that actually matters. Expiry still bounds the wait.
                await this.mutateDelivery(workId, (d) => ({ ...d, lastError: result.code }));
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
        const next = await this.store.mutate(workId, (work) => {
            if (!work.delivery) return undefined;
            const updated = update(work.delivery);
            if (updated === work.delivery) return undefined;
            return { ...work, updatedAt: this.clock.now(), delivery: updated };
        });
        this.onChange(workId);
        return next?.delivery;
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
