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
 * fire during downtime is replayed once if true, dropped if false; a job
 * that has never run also fires once at boot, since arming the flag asks
 * for a run on the next startup. Most recurring jobs want false (a "every
 * morning at 9am" job after a 3-day downtime should not run 3 times in
 * a row).
 */

import type { TSchema } from "typebox";
import { Type } from "typebox";

export type ScheduleSpec =
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "interval"; ms: number };

/**
 * Typebox schema mirror of ScheduleSpec, kept available for future JSON
 * validation of on-disk job files. Currently jobs are loaded by direct
 * TypeScript decode (see scheduler/store.ts) and never round-trip through
 * a schema validator.
 *
 * @internal
 */
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
    /** Cap on *successful* runs before the job retires itself (sets
     *  `enabled: false` and stops its timer). Absent = unlimited.
     *
     *  Exists because `ScheduleSpec` has no one-shot kind: asking for "run
     *  this once, now" previously meant faking a long interval and
     *  remembering to delete the job afterwards. When the delete was
     *  forgotten the job kept firing on that fake schedule forever.
     *  `max_runs: 1` expresses the intent directly. */
    max_runs?: number;
    /** Successful runs so far — server-managed, incremented only on
     *  `status: "ok"`. Client-supplied values are overwritten by
     *  JobsController (same rule as `history`), otherwise a caller could
     *  reset the counter and escape its own `max_runs`. */
    run_count?: number;
    /** Circuit breaker: consecutive failed fires tolerated before the job
     *  retires itself. Absent = DEFAULT_MAX_CONSECUTIVE_FAILURES; an
     *  explicit 0 disables the breaker.
     *
     *  Counts *consecutive* failures (any success resets it) so a job that
     *  fails intermittently is never retired for transient trouble. Guards
     *  the case `max_runs` cannot: a job whose command is permanently
     *  broken (bad credentials, removed binary) never reaches a success, so
     *  a success-only cap would let it retry on schedule forever. */
    max_consecutive_failures?: number;
    /** Consecutive failed fires — server-managed, reset to 0 by any
     *  success. Same anti-tamper rule as `run_count`. */
    consecutive_failures?: number;
    /** Why the scheduler disabled this job on its own. Set alongside
     *  `enabled: false` when a cap or the breaker trips, so an operator
     *  can tell self-retirement from a manual toggle. Not folded into
     *  `history` because that ring holds only HISTORY_LIMIT entries and
     *  would eventually discard the reason. Cleared when a job is
     *  re-enabled. */
    disabled_reason?: string;
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

/** Outcome of one job fire, surfaced to `jobs.runNow` callers so a force-fire
 *  reports what actually happened instead of only whether the lock was
 *  acquired. `skipped` = an overlapping fire held the lock (this fire was
 *  dropped, not queued); `failed` carries the invocation error. Without this,
 *  a run whose `session.prompt` was rejected still rendered as "fired" and the
 *  caller had to read history to learn otherwise. */
export interface JobRunResult {
    status: "ok" | "skipped" | "failed";
    error?: string;
}

export const HISTORY_LIMIT = 20;

/** Consecutive-failure budget applied when a job sets no explicit
 *  `max_consecutive_failures`. Deliberately not 1–2: a fire that exceeds
 *  `fireTimeoutMs` also records `err`, so a job whose model turn is merely
 *  slow can accumulate a few non-genuine failures before doing real work. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
