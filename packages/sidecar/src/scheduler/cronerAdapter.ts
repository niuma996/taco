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
