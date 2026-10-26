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

import type {
    JobScheduleSpec,
    Actor as ProtocolActor,
    Job as ProtocolJob,
    JobHistoryEntry as ProtocolJobHistoryEntry,
    JobRunResult as ProtocolJobRunResult,
    SessionStrategy as ProtocolSessionStrategy,
} from "@taco-ai/protocol";
import type { TSchema } from "typebox";
import { Type } from "typebox";

/**
 * The schedule shape. Defined in `@taco-ai/protocol` because it crosses the
 * wire inside a `Job`; the scheduler re-exports it under its historical
 * name so the scheduler internals read unchanged.
 */
export type ScheduleSpec = JobScheduleSpec;

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

/** One past run of a job. The wire shape lives in `@taco-ai/protocol`. */
export type JobHistoryEntry = ProtocolJobHistoryEntry;

/** Per-call caller identity, attached to jobs.* RPC params so the server
 *  can enforce IM-scope (one channel/peer) vs IDE-scope (one fs workspace).
 *  Tool calls close over the actor at construction; legacy desktop paths
 *  pass undefined for backward-compatible admin access. The wire shape
 *  lives in `@taco-ai/protocol`. */
export type Actor = ProtocolActor;

/** How the scheduler picks a session when an `agent.invoke` job fires.
 *  - `new`  : non-IM only — every fire creates a fresh `sched-<uuid>` session.
 *  - `reuse`: IM only — finds the existing session attached to the
 *             (channelId, peerId, chatId) triple and re-prompts it. Lets a
 *             scheduled task continue the current channel conversation.
 *  - `pin`  : non-IM default — first fire creates `sched-pin-<jobId>` and stores the id on
 *             the job; subsequent fires attach that session. Lets a job
 *             maintain a single persistent context across many fires. */
export type SessionStrategy = ProtocolSessionStrategy;

/**
 * A scheduled job as the scheduler holds it.
 *
 * The wire shape lives in `@taco-ai/protocol`, where `history` is optional
 * because the desktop never sends it. The scheduler always has it — the
 * store seeds `[]` on read — so it narrows the field back to required here
 * rather than scattering `?? []` through the scheduler.
 */
export type Job = Omit<ProtocolJob, "history"> & { history: JobHistoryEntry[] };
/** Outcome of one job fire, surfaced to `jobs.runNow` callers so a force-fire
 *  reports what actually happened instead of only whether the lock was
 *  acquired. `skipped` = an overlapping fire held the lock (this fire was
 *  dropped, not queued); `failed` carries the invocation error. Without this,
 *  a run whose `session.prompt` was rejected still rendered as "fired" and the
 *  caller had to read history to learn otherwise. */
export type JobRunResult = ProtocolJobRunResult;

export const HISTORY_LIMIT = 20;

/** Consecutive-failure budget applied when a job sets no explicit
 *  `max_consecutive_failures`. Deliberately not 1–2: a fire that exceeds
 *  `fireTimeoutMs` also records `err`, so a job whose model turn is merely
 *  slow can accumulate a few non-genuine failures before doing real work. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
