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

import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.ts";
import type { ScheduledHandle } from "./cronerAdapter.ts";
import { scheduleNext } from "./cronerAdapter.ts";
import { HISTORY_LIMIT, type Job, type JobHistoryEntry } from "./types.ts";

const log = createLogger("sidecar.scheduler");

/** Function signature for the command dispatcher — the daemon supplies an
 *  implementation that routes `command` + `args` to the existing RPC
 *  pipeline (e.g. agent.invoke → session.create + session.prompt). */
export type CommandInvoker = (command: string, args: Record<string, unknown>) => Promise<void>;

export interface SchedulerOptions {
    store: {
        list: () => Promise<Job[]>;
        save: (job: Job) => Promise<void>;
        get: (id: string) => Promise<Job | null>;
        delete: (id: string) => Promise<void>;
    };
    /** Root for <id>.lock files; defaults to the store's directory. */
    lockDir?: string;
    invoke: CommandInvoker;
    /** Override `Date.now` / `new Date()` for deterministic tests. */
    now?: () => Date;
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
     *  `jobs.run_now` RPC. Returns true if the fire actually ran, false
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
        job.history = [entry, ...job.history].slice(0, HISTORY_LIMIT);

        try {
            await this.opts.invoke(job.command, job.args);
            entry.status = "ok";
        } catch (err) {
            entry.status = "err";
            entry.error = err instanceof Error ? err.message : String(err);
            log.warn(`job ${job.id} failed: ${entry.error}`);
        } finally {
            entry.ended_at = this.nowString();
            job.last_run_at = entry.ended_at;
            await this.opts.store.save(job).catch((err) => {
                log.error(`failed to persist history for ${job.id}: ${String(err)}`);
            });
            await unlink(lockPath).catch(() => {
                /* lock may have been removed by another process — fine */
            });
        }
        return acquired;
    }

    private nowString(): string {
        return (this.opts.now ?? (() => new Date()))().toISOString();
    }

    private nowMs(): number {
        return this.opts.now ? this.opts.now().getTime() : Date.now();
    }

    /** Replay a job only if it last ran in the past. A job that has never
     *  run is always eligible (a "missed run" since the daemon has never
     *  seen it). The 5-second grace window prevents a clock skew between
     *  store and host from double-firing an honest just-completed run. */
    private shouldReplayMissedRun(job: Job): boolean {
        if (!job.last_run_at) return true;
        const lastRunMs = Date.parse(job.last_run_at);
        if (!Number.isFinite(lastRunMs)) return true;
        return this.nowMs() - lastRunMs > 5_000;
    }
}
