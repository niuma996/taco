/**
 * Scheduler types — persisted job definitions + their in-flight history.
 *
 * Jobs live as one JSON file per id under $TACO_HOME/jobs/<id>.json — the
 * durable contract between the UI and the daemon. The UI writes through
 * `jobs.*` RPCs, which reload the schedule immediately; there is no filesystem
 * watcher, so a hand-edited file takes effect only after a restart.
 *
 * History is a 20-entry ring in the same JSON. A `<id>.lock` file keeps one
 * job's fires from overlapping. `run_on_startup` (snake_case — the JSON is the
 * user-facing contract) governs catch-up on restart. When true, an enabled
 * job replays one missed fire or runs once at boot if it has never run;
 * when false, neither startup run is requested.
 */

import type {
    JobScheduleSpec,
    Actor as ProtocolActor,
    Job as ProtocolJob,
    JobHistoryEntry as ProtocolJobHistoryEntry,
    JobRunResult as ProtocolJobRunResult,
    SessionStrategy as ProtocolSessionStrategy,
} from "@taco-ai/protocol";

/**
 * The schedule shape. Defined in `@taco-ai/protocol` because it crosses the
 * wire inside a `Job`; the scheduler re-exports it under its historical
 * name so the scheduler internals read unchanged.
 */
export type ScheduleSpec = JobScheduleSpec;

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

export { DEFAULT_MAX_CONSECUTIVE_FAILURES } from "@taco-ai/protocol";
