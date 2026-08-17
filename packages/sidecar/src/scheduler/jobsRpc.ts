/**
 * Local RPC method-name constants for the scheduler's jobs.* surface.
 *
 * Lives in the scheduler module rather than `@taco-ai/shared` so PR4
 * doesn't widen the shared package. The UI mirrors these strings in
 * `clients/taco-desktop/src/lib/jobsRpc.ts` — a single integration test
 * catches drift.
 *
 * Method names:
 *   jobs.list      — list every job in $TACO_HOME/jobs
 *   jobs.get       — read a single job by id
 *   jobs.create    — create a new job (server assigns id when missing)
 *   jobs.update    — replace an existing job
 *   jobs.delete    — remove a job + its lock file
 *   jobs.run_now   — force-fire a job outside its schedule
 *   jobs.history   — read just the history entries (no live state)
 */

export const JOBS_RPC = {
    list: "jobs.list",
    get: "jobs.get",
    create: "jobs.create",
    update: "jobs.update",
    delete: "jobs.delete",
    runNow: "jobs.run_now",
    history: "jobs.history",
} as const;

export type JobsRpcMethod = (typeof JOBS_RPC)[keyof typeof JOBS_RPC];
