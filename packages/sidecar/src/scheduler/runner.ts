/**
 * Scheduler — picks up jobs from the store on startup, schedules each
 * enabled one via croner / setInterval, and routes the fire callback
 * through `runJob` which writes history + invokes the user-supplied
 * command handler.
 *
 * Concurrency: each job gets a `<id>.lock` file acquired via `wx` (write-
 * exclusive). If a previous run hasn't finished when the schedule fires
 * again, the new fire is dropped — better than letting model turns
 * stack up. The lock is released in `finally` even on error.
 *
 * The `invoke` callback is supplied by the daemon (not owned by this
 * module) so the scheduler doesn't have to know how `agent.invoke`
 * dispatches into the workspace runtime. Returning a rejected promise
 * counts as a run with status=err; the error message lands in history.
 */

import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.ts";
import type { ScheduledHandle } from "./cronerAdapter.ts";
import { nextFireAfter, scheduleNext } from "./cronerAdapter.ts";
import { HISTORY_LIMIT, type Job, type JobHistoryEntry } from "./types.ts";

const log = createLogger("sidecar.scheduler");

/** Probe whether a pid is alive. We don't care why it's gone — ESRCH means
 *  the OS doesn't have the process, EPERM means it's not ours to signal.
 *  Both are safe to treat as "not a current owner" for lock cleanup. */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        return code === undefined; // undefined = no error, signal accepted
    }
}

/** Function signature for the command dispatcher — the daemon supplies an
 *  implementation that routes the job's `command` to the existing RPC
 *  pipeline (e.g. agent.invoke → session.create + session.prompt). The
 *  dispatcher receives the whole job so it can read sessionStrategy /
 *  pinnedSessionId without the runner having to unpack them. */
export type CommandInvoker = (job: Job) => Promise<void>;

export interface SchedulerOptions {
    store: {
        list: () => Promise<Job[]>;
        save: (job: Job) => Promise<void>;
        // Required — the runner uses `mutate` as its sole read-modify-
        // write primitive to avoid races with concurrent dispatcher
        // callbacks (see JobsController's update + onPinnedSessionCreated
        // paths). JobStore implements it; callers that supply a custom
        // store MUST implement it too. The earlier optional-fallback
        // branch to `get + save` is gone because that path has the
        // exact ABA problem `mutate`'s queue solves.
        mutate: (id: string, update: (current: Job | null) => Job | null) => Promise<Job | null>;
        get: (id: string) => Promise<Job | null>;
        delete: (id: string) => Promise<void>;
    };
    /** Root for <id>.lock files; defaults to the store's directory. */
    lockDir?: string;
    invoke: CommandInvoker;
    /** Override `Date.now` / `new Date()` for deterministic tests. */
    now?: () => Date;
    /** Per-fire timeout. If `invoke` doesn't settle in this window it is
     *  rejected with a "fire timeout" error so the runner's finally block
     *  can land the history entry + clear the lock. Default 5 min — long
     *  enough for a model turn with reasoning, short enough that a hung
     *  push frame doesn't wedge the schedule forever. */
    fireTimeoutMs?: number;
    /** A lock file older than this is considered abandoned and removed at
     *  start(). A lock from a process that crashed won't be reaped by the
     *  OS — only by this heuristic. Default 1 h. */
    staleLockMs?: number;
}

const DEFAULT_FIRE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STALE_LOCK_MS = 60 * 60_000;

class FireTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`fire timeout after ${Math.round(timeoutMs / 60_000)}m`);
        this.name = "FireTimeoutError";
    }
}

export class Scheduler {
    private readonly handles = new Map<string, ScheduledHandle>();
    private running = false;
    private bootReplayed = false;

    constructor(private readonly opts: SchedulerOptions) {}

    /** Walk the store, schedules each enabled job, and replays any
     *  run_on_startup jobs that missed a fire window on first boot.
     *  Idempotent: re-calling drops existing timers first (so a hot
     *  reload of jobs doesn't accumulate). */
    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        await this.cleanStaleLocks();
        const jobs = await this.opts.store.list();
        if (!this.bootReplayed) {
            this.bootReplayed = true;
            for (const job of jobs) {
                if (job.enabled && job.run_on_startup && this.shouldReplayMissedRun(job)) {
                    // Fire-and-forget — `start()` must not block on user prompts.
                    // The first regular schedule fire is independent; it will fire
                    // at its normal cadence.
                    void this.runJob(job).catch((err: unknown) => {
                        log.error(`missed-run for ${job.id} failed: ${String(err)}`);
                    });
                }
            }
        }
        for (const job of jobs) {
            if (job.enabled) this.attach(job);
        }
        log.info(`scheduler started with ${this.handles.size} job(s)`);
    }

    /** Stop all timers and forget them. The OS will reap any in-flight
     *  invocations — they hold their own locks and finish naturally. */
    stop(): void {
        for (const handle of this.handles.values()) handle.stop();
        this.handles.clear();
        this.running = false;
    }

    /** Tear down the timer for `id` (if any) and re-attach from the latest
     *  store copy. Called by the file-watcher when the UI edits a job. */
    async reload(id: string): Promise<void> {
        this.detach(id);
        const job = await this.opts.store.get(id);
        if (job?.enabled) this.attach(job);
    }

    /** Force-fire a job immediately, bypassing the schedule. Used by
     *  `jobs.runNow` RPC. Returns true if the fire actually ran, false
     *  if it was rejected by an existing lock. */
    async runNow(id: string): Promise<boolean> {
        const job = await this.opts.store.get(id);
        if (!job) return false;
        return this.runJob(job);
    }

    /** Tear down every timer and forget them. The Scheduler can be
     *  `start()`-ed again afterwards. */
    detachAll(): void {
        this.stop();
    }

    private attach(job: Job): void {
        const handle = scheduleNext(job.schedule, () => {
            void this.runJob(job).catch((err) => {
                log.error(`unhandled error in scheduled fire for ${job.id}: ${String(err)}`);
            });
        });
        this.handles.set(job.id, handle);
    }

    private detach(id: string): void {
        const existing = this.handles.get(id);
        if (existing) {
            existing.stop();
            this.handles.delete(id);
        }
    }

    private async runJob(job: Job): Promise<boolean> {
        const lockPath = join(this.opts.lockDir ?? ".", `${job.id}.lock`);
        let acquired = false;
        try {
            // `wx` → create-only; EEXIST means another invocation holds the lock.
            await writeFile(
                lockPath,
                JSON.stringify({ pid: process.pid, started_at: this.nowString() }),
                { flag: "wx" },
            );
            acquired = true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                log.info(`job ${job.id} still running; skipping overlapping fire`);
                return false;
            }
            throw err;
        }

        const entry: JobHistoryEntry = {
            started_at: this.nowString(),
            status: "running",
        };
        // Defensive: callers may hand us a job object that bypassed the
        // store (e.g. a future direct-API path). The store already
        // normalizes `history` to [] on read, but a missing field would
        // crash the spread above and lose the entire run.
        job.history = [entry, ...(job.history ?? [])].slice(0, HISTORY_LIMIT);

        let releaseLockAfterInvocation = true;
        let completion: Promise<void> | undefined;
        try {
            const invocation = this.invokeWithTimeout(job);
            completion = invocation.completion;
            await invocation.result;
            entry.status = "ok";
        } catch (err) {
            entry.status = "err";
            entry.error = err instanceof Error ? err.message : String(err);
            if (err instanceof FireTimeoutError && completion) {
                releaseLockAfterInvocation = false;
                void completion
                    .catch(() => undefined)
                    .finally(() => {
                        void unlink(lockPath).catch(() => undefined);
                    });
            }
            log.warn(`job ${job.id} failed: ${entry.error}`);
        } finally {
            entry.ended_at = this.nowString();
            job.last_run_at = entry.ended_at;
            // Re-read before writing. `job` was captured before invoke ran,
            // and invoke legitimately mutates the stored copy mid-fire — the
            // pin strategy's onPinnedSessionCreated writes `pinnedSessionId`
            // while we're awaiting. Saving our stale snapshot would drop that
            // field, so every subsequent fire would re-enter the "no pinned
            // session yet" branch and create another session (we found 9
            // duplicate jsonl files for one pin job this way). Only the two
            // fields this fire owns are layered onto the latest copy.
            await this.opts.store
                .mutate(job.id, (latest) => {
                    if (!latest || latest.generation !== job.generation) return latest;
                    return { ...latest, history: job.history, last_run_at: entry.ended_at };
                })
                .catch((err) => {
                    log.error(`failed to persist history for ${job.id}: ${String(err)}`);
                });
            if (releaseLockAfterInvocation) {
                await unlink(lockPath).catch(() => {
                    /* lock may have been removed by another process — fine */
                });
            }
        }
        return acquired;
    }

    private nowString(): string {
        return (this.opts.now ?? (() => new Date()))().toISOString();
    }

    private nowMs(): number {
        return this.opts.now ? this.opts.now().getTime() : Date.now();
    }

    /**
     * Decide whether a `run_on_startup` job should fire at boot: either it
     * has never run at all, or the schedule would have fired at least once
     * between `last_run_at` and now (a missed window during downtime).
     *
     * Earlier we treated "last ran more than 5s ago" as a miss. That was
     * wrong on two fronts:
     *   - For interval jobs: a 24h schedule on a job that ran 1m ago is
     *     not "missed" — the next fire is still 23h59m in the future.
     *   - For cron jobs: a "every day at 09:00" schedule that last ran
     *     yesterday at 09:00 and the daemon restarted at 10:00 should
     *     replay (missed today's 09:00), but the same schedule on a
     *     job that ran an hour ago should not.
     *
     * `nextFireAfter(spec, lastRunAt)` gives us the next scheduled
     * fire strictly after `lastRunAt`. If that time has already
     * passed at startup time, we missed it. A job that has never run
     * (`last_run_at` unset) replays unconditionally: the user armed
     * `run_on_startup` precisely to get a run on the next boot, and
     * without this a fresh 24h-interval job would sit idle for a full
     * interval after the restart that created it.
     *
     * The 5-second skew window still applies at the comparison edge:
     * without it, a clock-jump or a "fire just landed as we shut down"
     * race could double-fire an honest just-completed run.
     */
    private shouldReplayMissedRun(job: Job): boolean {
        if (!job.last_run_at) return true;
        const lastRunMs = Date.parse(job.last_run_at);
        if (!Number.isFinite(lastRunMs)) return false;
        const expected = nextFireAfter(job.schedule, new Date(lastRunMs));
        if (!expected) return false;
        // The scheduled fire time has passed during downtime AND we're
        // outside the skew grace. The grace keeps clock drift between
        // the scheduler and the host from double-firing.
        return this.nowMs() - expected.getTime() > 5_000;
    }

    /** Bound a fire so a hung agent.invoke (e.g. a pinned session stuck
     *  waiting for push frames nobody is subscribed to) can't trap the
     *  history + lock forever. The timeout rejects with an Error so the
     *  caller's catch path turns it into `status: "err"` exactly like any
     *  other failure. The underlying invoke keeps running in the
     *  background — we can't cancel it from this layer, but we don't need
     *  to: when it finally settles, its then/catch is detached and the
     *  process holds no more state for the job than its own promise. */
    private invokeWithTimeout(job: Job): { result: Promise<void>; completion: Promise<void> } {
        const timeoutMs = this.opts.fireTimeoutMs ?? DEFAULT_FIRE_TIMEOUT_MS;
        const fire = Promise.resolve().then(() => this.opts.invoke(job));
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((_, reject) => {
            timer = setTimeout(() => reject(new FireTimeoutError(timeoutMs)), timeoutMs);
            // Don't keep the event loop alive just for the watchdog.
            timer.unref();
        });
        const result = Promise.race([fire, timeout]).finally(() => {
            if (timer) clearTimeout(timer);
        });
        return { result, completion: fire };
    }

    /** Remove lock files that nobody is going to release: either the
     *  owning pid is dead, or the lock is older than `staleLockMs`.
     *  Without this, a daemon that crashed mid-fire leaves a `<id>.lock`
     *  on disk and the next process's `start()` sees the schedule as
     *  permanently busy. We deliberately don't touch locks held by a
     *  live pid — even if it's been held "a while", the owner might
     *  just be a slow model turn. */
    private async cleanStaleLocks(): Promise<void> {
        const lockDir = this.opts.lockDir;
        if (!lockDir) return;
        const staleMs = this.opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
        const cutoff = this.nowMs() - staleMs;
        let entries: string[];
        try {
            entries = await readdir(lockDir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
            log.warn(`could not scan ${lockDir} for stale locks: ${String(err)}`);
            return;
        }
        for (const entry of entries) {
            if (!entry.endsWith(".lock")) continue;
            const path = join(lockDir, entry);
            try {
                const raw = await readFile(path, "utf-8").catch(() => null);
                let owner: { pid?: number; started_at?: string } | null = null;
                if (raw) {
                    try {
                        owner = JSON.parse(raw) as { pid?: number; started_at?: string };
                    } catch {
                        owner = null;
                    }
                }
                const startedMs = owner?.started_at ? Date.parse(owner.started_at) : NaN;
                const ageExpired = Number.isFinite(startedMs) && startedMs < cutoff;
                const pidDead = owner?.pid !== undefined && !isPidAlive(owner.pid);
                if (ageExpired || pidDead || !owner) {
                    await unlink(path).catch(() => {
                        /* raced with another process — fine */
                    });
                    log.warn(
                        `removed stale lock ${path} (pidDead=${pidDead} ageExpired=${ageExpired})`,
                    );
                }
            } catch (err) {
                log.warn(`failed to inspect lock ${path}: ${String(err)}`);
            }
        }
    }
}
