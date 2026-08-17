/**
 * Scheduler types — persisted job definitions + their in-flight history.
 *
 * Jobs live as one JSON file per id under $TACO_HOME/jobs/<id>.json. The
 * file is the durable contract between the UI (which creates / edits /
 * deletes them) and the daemon (which reads them on startup and watches
 * for fs changes to pick up edits without restart).
 *
 * History is a 20-entry ring stored inside the same JSON; it's truncated
 * on every run rather than maintained separately so a single file write
 * carries the whole state machine. The lock file <id>.lock (not modeled
 * in this type — it's purely a runtime concern) prevents overlapping
 * runs of the same job when the schedule fires faster than the command
 * completes (e.g. a 1-minute `agent.invoke` whose model turn takes 90s).
 *
 * `run_on_startup` (deliberately snake_case — the JSON shape is the user-
 * facing contract) governs catch-up behavior on daemon restart: a missed
 * fire during downtime is replayed once if true, dropped if false. Most
 * recurring jobs want false (a "every morning at 9am" job after a 3-day
 * downtime should not run 3 times in a row).
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";

export type ScheduleSpec =
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "interval"; ms: number };

export const scheduleSpecSchema: TSchema = Type.Union([
    Type.Object({
        kind: Type.Literal("cron"),
        expr: Type.String({ minLength: 1 }),
        tz: Type.Optional(Type.String()),
    }),
    Type.Object({
        kind: Type.Literal("interval"),
        ms: Type.Integer({ minimum: 1 }),
    }),
]);

export interface JobHistoryEntry {
    started_at: string;
    ended_at?: string;
    status: "running" | "ok" | "err";
    error?: string;
}

export interface Job {
    id: string;
    name: string;
    schedule: ScheduleSpec;
    /** RPC-style method name the scheduler will invoke when the job fires,
     *  e.g. `agent.invoke`. The daemon's command dispatcher resolves it
     *  to a registered handler at run time. */
    command: string;
    /** Free-form argument bag passed verbatim to the command. */
    args: Record<string, unknown>;
    enabled: boolean;
    /** Whether to replay a missed fire when the daemon comes back up.
     *  Only applies when `enabled` is also true. */
    run_on_startup: boolean;
    last_run_at?: string;
    next_run_at?: string;
    /** Newest-first; capped at HISTORY_LIMIT (20) entries. */
    history: JobHistoryEntry[];
}

export const HISTORY_LIMIT = 20;
