/**
 * Built-in scheduled jobs — system tasks the daemon seeds itself and runs
 * through a native handler instead of an agent prompt.
 *
 * A built-in job is an ordinary `Job` file (same store, timer, lock, history,
 * failure breaker, Schedules UI) with `builtin: true` and a command from
 * `BUILTIN_JOB_COMMANDS`. The rules that make it safe to show in a CRUD UI:
 *   - only the daemon creates one (seeded at boot under a fixed id);
 *   - it cannot be deleted, only disabled;
 *   - `command`, `builtin` and the id are fixed; schedule, enabled and the
 *     handler's own args stay editable;
 *   - it carries no workspace, so workspace-scoped actors (the model's jobs
 *     tools) never see it.
 */

import type { DreamOptions } from "../memory/dream/dreamPlan.ts";
import { DEFAULT_DREAM_OPTIONS } from "../memory/dream/dreamPlan.ts";
import type { Job } from "./types.ts";

export const MEMORY_DREAM_COMMAND = "memory.dream";
export const MEMORY_DREAM_JOB_ID = "memory-dream";

/** Commands only built-in jobs may carry. */
export const BUILTIN_JOB_COMMANDS: ReadonlySet<string> = new Set([MEMORY_DREAM_COMMAND]);

export function isBuiltinJob(job: Pick<Job, "builtin" | "command">): boolean {
    return job.builtin === true && BUILTIN_JOB_COMMANDS.has(job.command);
}

/** Args the memory-dream job accepts; every field is optional. */
export interface MemoryDreamArgs extends Partial<DreamOptions> {
    /** Model for the consolidation call, as `provider/modelId` or a bare id. */
    model?: string;
}

const DREAM_ARG_LIMITS: Record<keyof DreamOptions, { min: number; max: number }> = {
    minHours: { min: 1, max: 24 * 30 },
    minChanges: { min: 0, max: 1000 },
    staleDays: { min: 7, max: 3650 },
    staleDaysDurable: { min: 7, max: 3650 },
};

/**
 * Validate the memory-dream args the Schedules UI sends. Returns the cleaned
 * args (unknown keys dropped) or an error message.
 */
export function parseMemoryDreamArgs(
    args: Record<string, unknown>,
): { ok: true; args: MemoryDreamArgs } | { ok: false; error: string } {
    const out: { -readonly [K in keyof MemoryDreamArgs]: MemoryDreamArgs[K] } = {};
    for (const key of Object.keys(DREAM_ARG_LIMITS) as Array<keyof DreamOptions>) {
        const value = args[key];
        if (value === undefined) continue;
        const { min, max } = DREAM_ARG_LIMITS[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            return { ok: false, error: `args.${key} must be an integer in [${min}, ${max}]` };
        }
        out[key] = value;
    }
    if (args.model !== undefined && args.model !== "") {
        if (typeof args.model !== "string" || args.model.length > 200) {
            return { ok: false, error: "args.model must be a model id string" };
        }
        out.model = args.model;
    }
    return { ok: true, args: out };
}

/** Initial job for the daemon to seed: on by default, nightly, catch-up on boot. */
export function defaultMemoryDreamJob(): Job {
    return {
        id: MEMORY_DREAM_JOB_ID,
        name: "Memory consolidation",
        // 04:17 local: off the hour, and when the machine is likely idle.
        schedule: { kind: "cron", expr: "17 4 * * *" },
        command: MEMORY_DREAM_COMMAND,
        args: {
            minHours: DEFAULT_DREAM_OPTIONS.minHours,
            minChanges: DEFAULT_DREAM_OPTIONS.minChanges,
            staleDays: DEFAULT_DREAM_OPTIONS.staleDays,
            staleDaysDurable: DEFAULT_DREAM_OPTIONS.staleDaysDurable,
        },
        enabled: true,
        // A laptop asleep at 04:17 still consolidates on its next boot.
        run_on_startup: true,
        builtin: true,
        run_count: 0,
        consecutive_failures: 0,
        history: [],
        generation: "",
    };
}
