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

/** Per-call caller identity, attached to jobs.* RPC params so the server
 *  can enforce IM-scope (one channel/peer) vs IDE-scope (one fs workspace).
 *  Tool calls close over the actor at construction; legacy desktop paths
 *  pass undefined for backward-compatible admin access. */
export type Actor =
    | { kind: "im"; channelId: string; peerId: string; chatId: string }
    | { kind: "ide"; workspace: string };

/** How the scheduler picks a session when an `agent.invoke` job fires.
 *  - `new`  : non-IM only — every fire creates a fresh `sched-<uuid>` session.
 *  - `reuse`: IM only — finds the existing session attached to the
 *             (channelId, peerId, chatId) triple and re-prompts it. Lets a
 *             scheduled task continue the current channel conversation.
 *  - `pin`  : non-IM default — first fire creates `sched-pin-<jobId>` and stores the id on
 *             the job; subsequent fires attach that session. Lets a job
 *             maintain a single persistent context across many fires. */
export type SessionStrategy = "new" | "reuse" | "pin";

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
    /** Newest-first; capped at HISTORY_LIMIT (20) entries. The store
     *  normalizes older on-disk files (where this field was absent) to
     *  an empty array on read, so in-memory Jobs always carry one. */
    history: JobHistoryEntry[];
    /** Server-generated identity for this incarnation of the job. */
    generation?: string;
    /** IM scope (server-derived from `args.workspace` when im://). Callers
     *  MUST NOT set this directly — JobsController derives it from the
     *  workspace at create/update time and ignores caller-supplied values
     *  so a malicious IM tool can't escape its sandbox by editing the
     *  fields. */
    channelId?: string;
    /** Peer scope — same derivation rule as channelId. */
    peerId?: string;
    /** IM defaults to `reuse` and only permits `reuse`. Filesystem workspaces
     *  default to `pin` and may explicitly select `new`. */
    sessionStrategy?: SessionStrategy;
    /** Set after the first fire of a `pin` job. The dispatcher stores the
     *  sessionId here so subsequent fires can attach the same session. */
    pinnedSessionId?: string;
}

export const HISTORY_LIMIT = 20;
