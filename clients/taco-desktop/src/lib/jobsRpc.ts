/**
 * UI-side mirror of `packages/sidecar/src/scheduler/jobsRpc.ts`.
 *
 * PR4 keeps the jobs.* RPC method names in the sidecar's scheduler module
 * rather than `@taco-ai/shared` (which is shared with the protocol package
 * and would force a cross-PR widening). The UI duplicates the strings
 * here. No test compares this copy to the sidecar's — keep the two in sync by
 * hand.
 *
 * Segment casing follows the shared `namespace.action` convention; the
 * LLM-facing tool names drop the dot and live in `tools/jobs.ts`.
 */

export const JOBS_RPC = {
    list: "jobs.list",
    get: "jobs.get",
    create: "jobs.create",
    update: "jobs.update",
    delete: "jobs.delete",
    runNow: "jobs.runNow",
    history: "jobs.history",
} as const;

export type JobsRpcMethod = (typeof JOBS_RPC)[keyof typeof JOBS_RPC];
