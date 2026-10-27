/**
 * `jobs.*` wire contract — the scheduler's RPC surface.
 *
 * These types live in the protocol package because they cross the wire: the
 * sidecar serves them, the desktop renders them, and the LLM tools call
 * them. Keeping one definition here is what stops the two copies the
 * sidecar and the desktop used to carry from drifting apart.
 *
 * The request shapes are derived from the typebox schemas in
 * `schemas/jobs.ts` — the schema is the single definition of a job's wire
 * shape, and the types below are read off it. Result types have no schema
 * (there is nothing to validate on the way out), so they stay written out.
 *
 * The scheduler's internal types (`HISTORY_LIMIT`, the on-disk file shape)
 * stay in the sidecar — only the wire shapes belong here.
 */

import type { ParamsOf } from "./rpcContract/types.js";
import type {
    actorSchema,
    jobCreateBody,
    jobHistoryEntrySchema,
    jobScheduleSchema,
    jobSchema,
    jobsCreateSchema,
    jobsIdSchema,
    jobsListSchema,
    jobsUpdateSchema,
    sessionStrategySchema,
} from "./schemas/jobs.js";

/** How the scheduler picks a session when an `agent.invoke` job fires. */
export type SessionStrategy = ParamsOf<typeof sessionStrategySchema>;

/** A job's schedule — either a cron expression or a fixed interval. */
export type JobScheduleSpec = ParamsOf<typeof jobScheduleSchema>;

/** One past run of a job. */
export type JobHistoryEntry = ParamsOf<typeof jobHistoryEntrySchema>;

/**
 * Per-call caller identity, attached to `jobs.*` params so the server can
 * enforce IM-scope (one channel/peer) vs IDE-scope (one fs workspace).
 *
 * Tool calls close over the actor at construction; legacy desktop paths
 * pass nothing for backward-compatible admin access.
 */
export type Actor = ParamsOf<typeof actorSchema>;

/**
 * A scheduled job as the wire carries it.
 *
 * The server owns the fields that track execution — `run_count`,
 * `consecutive_failures`, `history`, `generation` — and overwrites whatever
 * a client sends, so a caller cannot reset a counter or escape its cap. They
 * are optional here because the desktop never sends them.
 */
export type Job = ParamsOf<typeof jobSchema>;

/**
 * Outcome of one job fire, surfaced to `jobs.runNow` callers so a force-fire
 * reports what actually happened instead of only whether the lock was
 * acquired. `skipped` = an overlapping fire held the lock; `failed` carries
 * the invocation error.
 */
export interface JobRunResult {
    status: "ok" | "skipped" | "failed";
    error?: string;
}

/**
 * A job body as `jobs.create` receives it.
 *
 * `id` is optional because the daemon mints it: the server ignores whatever
 * the caller sends and generates a fresh one. The field is still declared so
 * a caller that echoes an id back (the desktop's edit path) validates.
 */
export type JobCreate = ParamsOf<typeof jobCreateBody>;

/** Params shared by the id-targeting methods. */
export type JobsIdParams = ParamsOf<typeof jobsIdSchema>;

/** Params for `jobs.update` — the job body must carry its id. */
export type JobsUpdateParams = ParamsOf<typeof jobsUpdateSchema>;

/** Params for `jobs.create` — the job body may omit its id. */
export type JobsCreateParams = ParamsOf<typeof jobsCreateSchema>;

/** `jobs.list` params — the actor scopes which jobs are visible. */
export type JobsListParams = ParamsOf<typeof jobsListSchema>;

export interface JobsListResult {
    jobs: Job[];
}

export interface JobsGetResult {
    job: Job | null;
}

export interface JobsWriteResult {
    job: Job;
}

export interface JobsDeleteResult {
    deleted: boolean;
}

export interface JobsHistoryResult {
    /**
     * The history entries, or `null` when the job does not exist. Mirrors the
     * controller's return type directly rather than indexing into `Job`:
     * the wire shape should not silently follow a change to whether `Job`
     * carries its history inline.
     */
    history: JobHistoryEntry[] | null;
}
