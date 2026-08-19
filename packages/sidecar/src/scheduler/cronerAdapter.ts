/**
 * Thin croner / setInterval adapter so the rest of the scheduler is
 * agnostic to which timer engine is in use. We isolate it here so a
 * croner major-version bump only touches one file, and so unit tests
 * can stub `scheduleNext` without depending on cron semantics.
 *
 * Croner exposes `{ stop, nextRun }` directly; setInterval doesn't, so
 * we wrap it in the same shape (nextRun for an interval is "now + ms",
 * which is approximate but correct enough for UI display).
 */

import { Cron } from "croner";
import type { ScheduleSpec } from "./types.ts";

export interface ScheduledHandle {
    stop(): void;
    nextRun(): Date | null;
}

/** Schedule `cb` according to `spec`. The returned handle MUST be stopped
 *  when the job is removed / disabled — leaking timers is a real risk
 *  with croner (each `Cron` keeps an internal Timeout + tick interval). */
export function scheduleNext(spec: ScheduleSpec, cb: () => void): ScheduledHandle {
    if (spec.kind === "interval") {
        const handle = setInterval(cb, spec.ms);
        return {
            stop: () => clearInterval(handle),
            // "Next run" for an interval is a lower bound — the actual fire
            // time depends on event-loop pressure. Returned as `now + ms`.
            nextRun: () => new Date(Date.now() + spec.ms),
        };
    }
    const cron = new Cron(spec.expr, spec.tz ? { timezone: spec.tz } : {}, cb);
    return {
        stop: () => cron.stop(),
        nextRun: () => cron.nextRun(),
    };
}

/**
 * Compute the next fire time strictly after `from`. For interval jobs
 * this is `from + interval.ms` (deterministic, timezone-free). For
 * cron jobs we instantiate a non-running `Cron` solely to call
 * `nextRun(from)` — the scheduler uses this to decide if a job missed a
 * fire window during downtime so the boot-replay path can replay it.
 *
 * Returns `undefined` when the schedule has no future fire (e.g. a cron
 * that already terminated, or an invalid spec). Callers treat that as
 * "no missed fire" rather than an error — a schedule that has run out
 * is its own terminal state.
 *
 * No scheduling side effects: croner starts an internal timer only when
 * a callback is supplied; we pass none, so this is safe to call from the
 * boot replay hot path.
 */
export function nextFireAfter(spec: ScheduleSpec, from: Date): Date | undefined {
    if (spec.kind === "interval") {
        const next = new Date(from.getTime() + spec.ms);
        return Number.isFinite(next.getTime()) ? next : undefined;
    }
    try {
        const cron = new Cron(spec.expr, spec.tz ? { timezone: spec.tz } : {});
        return cron.nextRun(from) ?? undefined;
    } catch {
        // Bad cron expression: surface as "no missed fire" rather than
        // crashing the boot. The next regular attach will fail to
        // schedule and the user will see the error in history.
        return undefined;
    }
}
