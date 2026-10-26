/**
 * `jobs.*` wire contract — the scheduler's RPC surface.
 *
 * These types live in the protocol package because they cross the wire: the
 * sidecar serves them, the desktop renders them, and the LLM tools call
 * them. Keeping one definition here is what stops the two copies the
 * sidecar and the desktop used to carry from drifting apart.
 *
 * The scheduler's internal types (`HISTORY_LIMIT`, the on-disk file shape)
 * stay in the sidecar — only the wire shapes belong here.
 */

/** How the scheduler picks a session when an `agent.invoke` job fires. */
export type SessionStrategy = "new" | "reuse" | "pin";

/** A job's schedule — either a cron expression or a fixed interval. */
export type JobScheduleSpec =
    | { kind: "cron"; expr: string; tz?: string }
    | { kind: "interval"; ms: number };

/** One past run of a job. */
export interface JobHistoryEntry {
    started_at: string;
    ended_at?: string;
    status: "running" | "ok" | "err";
    error?: string;
    /** One-line outcome a built-in handler reports (e.g. "merged 12→4"). */
    summary?: string;
}

/**
 * Per-call caller identity, attached to `jobs.*` params so the server can
 * enforce IM-scope (one channel/peer) vs IDE-scope (one fs workspace).
 *
 * Tool calls close over the actor at construction; legacy desktop paths
 * pass nothing for backward-compatible admin access.
 */
export type Actor =
    | { kind: "im"; channelId: string; peerId: string; chatId: string }
    | { kind: "ide"; workspace: string };

/**
 * A scheduled job as the wire carries it.
 *
 * The server owns the fields that track execution — `run_count`,
 * `consecutive_failures`, `history`, `generation` — and overwrites whatever
 * a client sends, so a caller cannot reset a counter or escape its cap. They
 * are optional here because the desktop never sends them.
 */
export interface Job {
    id: string;
    name: string;
    schedule: JobScheduleSpec;
    /**
     * RPC-style method name the scheduler will invoke when the job fires,
     * e.g. `agent.invoke`. The daemon's command dispatcher resolves it to a
     * registered handler at run time.
     */
    command: string;
    /** Free-form argument bag passed verbatim to the command. */
    args: Record<string, unknown>;
    /**
     * System job seeded by the daemon: runs a native handler, cannot be
     * deleted, and its command is fixed. Absent on every user-created job.
     */
    builtin?: boolean;
    enabled: boolean;
    /**
     * Whether to replay a missed fire when the daemon comes back up.
     * Only applies when `enabled` is also true.
     */
    run_on_startup: boolean;
    /**
     * Cap on *successful* runs before the job retires itself (sets
     * `enabled: false` and stops its timer). Absent = unlimited.
     */
    max_runs?: number;
    /** Successful runs so far — server-managed. */
    run_count?: number;
    /**
     * Circuit breaker: consecutive failed fires tolerated before the job
     * retires itself. Absent = the server default; an explicit 0 disables
     * the breaker.
     */
    max_consecutive_failures?: number;
    /** Consecutive failed fires — server-managed, reset by any success. */
    consecutive_failures?: number;
    /** Why the scheduler disabled this job on its own. */
    disabled_reason?: string;
    last_run_at?: string;
    next_run_at?: string;
    /** Newest-first run records. The server seeds `[]` on create. */
    history?: JobHistoryEntry[];
    /** Server-generated identity for this incarnation of the job. */
    generation?: string;
    /**
     * IM scope (server-derived from `args.workspace` when im://). Callers
     * MUST NOT set this directly — the server derives it and ignores
     * caller-supplied values so a malicious IM tool can't escape its sandbox.
     */
    channelId?: string;
    /** Peer scope — same derivation rule as channelId. */
    peerId?: string;
    /**
     * IM defaults to `reuse` and only permits `reuse`. Filesystem workspaces
     * default to `pin` and may explicitly select `new`.
     */
    sessionStrategy?: SessionStrategy;
    /** Set after the first fire of a `pin` job. */
    pinnedSessionId?: string;
}

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
export type JobCreate = Omit<Job, "id"> & { id?: string };

/** Params shared by the id-targeting methods. */
export interface JobsIdParams {
    id: string;
    actor?: Actor;
}

/** Params for `jobs.update` — the job body must carry its id. */
export interface JobsUpdateParams {
    job: Job;
    actor?: Actor;
}

/** Params for `jobs.create` — the job body may omit its id. */
export interface JobsCreateParams {
    job: JobCreate;
    actor?: Actor;
}

/** `jobs.list` params — the actor scopes which jobs are visible. */
export interface JobsListParams {
    actor?: Actor;
}

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
