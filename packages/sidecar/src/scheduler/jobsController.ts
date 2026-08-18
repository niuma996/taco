/**
 * JobsController — wraps the file-backed `JobStore` and the running
 * `Scheduler` so a single object can satisfy the `JobsControl` interface
 * the `jobs.*` RPC handlers see. Lives in the scheduler module (not in
 * the handler / server module) because the contract is owned by the
 * scheduler: the controller is just the bridge from "RPC params" to
 * "store mutation + timer attach/detach".
 *
 * Concurrency: `reload()` is idempotent (the Scheduler drops any prior
 * timer for the id before attaching a new one), so a UI-driven edit +
 * immediate list-then-fire is safe. `delete()` relies on the underlying
 * `reload(id)` semantics: after the store removes the file, reload reads
 * `null` and leaves the timer detached.
 *
 * Scope: every method takes an optional `actor`. An `im` actor can only
 * see jobs whose channelId+peerId match; an `ide` actor can see jobs
 * whose args.workspace matches the caller's workspace; `undefined`
 * means legacy/admin — all jobs visible. `create`/`update` additionally
 * re-derive `channelId`/`peerId` from `args.workspace` on the server
 * side and refuse any actor mismatch, so a malicious IM tool can't
 * escape its sandbox by editing those fields directly.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseImCwd } from "@taco-ai/protocol";
import { JobsScopeError } from "../lib/jobsErrors.ts";
import type { JobsControl } from "../runtime/serverRpcSurface.ts";
import type { Scheduler } from "./runner.ts";
import type { Actor, Job, JobHistoryEntry } from "./types.ts";

export class JobsController implements JobsControl {
    constructor(
        private readonly store: {
            list: () => Promise<Job[]>;
            get: (id: string) => Promise<Job | null>;
            save: (job: Job) => Promise<void>;
            delete: (id: string) => Promise<void>;
        },
        private readonly scheduler: Scheduler,
        private readonly lockDir: string,
    ) {}

    async list(actor?: Actor): Promise<Job[]> {
        const all = await this.store.list();
        if (!actor) return all;
        return all.filter((j) => isJobVisibleToActor(j, actor));
    }

    async get(id: string, actor?: Actor): Promise<Job | null> {
        const job = await this.store.get(id);
        if (!job) return null;
        if (actor && !isJobVisibleToActor(job, actor)) {
            // Don't leak existence to out-of-scope callers.
            return null;
        }
        return job;
    }

    async create(job: Job, actor?: Actor): Promise<Job> {
        const normalized = normalizeScopeFields(job);
        assertActorMatchesJob(normalized, actor);
        await this.store.save(normalized);
        // Re-load picks up the new copy; if `enabled`, the timer attaches.
        await this.scheduler.reload(normalized.id);
        return normalized;
    }

    async update(job: Job, actor?: Actor): Promise<Job> {
        const existing = await this.store.get(job.id);
        if (!existing) {
            throw new JobsScopeError("not_found", `job not found: ${job.id}`);
        }
        // Don't let the caller shift a job from one channel to another
        // (or from fs to IM) by submitting a new workspace. Anchor the
        // update to the existing scope — the caller can only edit
        // prompt/name/schedule/enabled, not the channel binding.
        const normalized = normalizeScopeFields({
            ...job,
            channelId: existing.channelId,
            peerId: existing.peerId,
        });
        assertActorMatchesJob(existing, actor);
        await this.store.save(normalized);
        await this.scheduler.reload(normalized.id);
        return normalized;
    }

    async delete(id: string, actor?: Actor): Promise<void> {
        const existing = await this.store.get(id);
        if (!existing) return;
        // Out-of-scope delete is a silent no-op — same existence-non-leak
        // rule as get/list. The handler surfaces `deleted: existed` from
        // its pre-check so the caller can distinguish "missing" from
        // "deleted"; the controller itself never throws on scope mismatch
        // here.
        if (actor && !isJobVisibleToActor(existing, actor)) return;
        // Remove the in-flight lock too — a job deleted mid-run should
        // not leak its lock file. We can't kill the running callback,
        // but the callback itself releases the lock on its `finally`
        // path (see runner.ts), and the lock will be GC'd by the OS.
        await this.store.delete(id);
        await unlink(join(this.lockDir, `${id}.lock`)).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
        });
        await this.scheduler.reload(id);
    }

    async runNow(id: string, actor?: Actor): Promise<boolean> {
        const existing = await this.store.get(id);
        if (!existing) return false;
        assertActorMatchesJob(existing, actor);
        return this.scheduler.runNow(id);
    }

    async history(id: string, actor?: Actor): Promise<JobHistoryEntry[] | null> {
        const job = await this.store.get(id);
        if (!job) return null;
        if (actor && !isJobVisibleToActor(job, actor)) return null;
        return job.history ?? null;
    }

    /** Sweep the store and finalize any `running` history entries to
     *  `status: "err"`. Called from the daemon's `uncaughtException`
     *  handler so a crash mid-fire leaves a breadcrumb instead of a
     *  forever-stuck entry. Best-effort: store errors are swallowed
     *  because we're already on the failure path and the process may
     *  not get another chance to write. */
    async markRunningAsErr(reason: string): Promise<void> {
        const all = await this.store.list().catch(() => []);
        for (const job of all) {
            if (!job.history) continue;
            let mutated = false;
            const nextHistory = job.history.map((entry) => {
                if (entry.status !== "running") return entry;
                mutated = true;
                return {
                    ...entry,
                    status: "err" as const,
                    error: `process exited: ${reason}`,
                    ended_at: new Date().toISOString(),
                };
            });
            if (!mutated) continue;
            await this.store.save({ ...job, history: nextHistory }).catch(() => {
                /* swallow — process is on the failure path */
            });
        }
    }
}

/** Derive `channelId`/`peerId` from `args.workspace` when it's `im://`,
 *  and zero out caller-supplied values so a malicious tool can't bypass
 *  scope by setting them itself. fs workspaces leave the fields blank. */
function normalizeScopeFields(job: Job): Job {
    const workspace = typeof job.args.workspace === "string" ? job.args.workspace : "";
    const parsed = workspace.startsWith("im://") ? parseImCwd(workspace) : undefined;
    if (parsed) {
        return { ...job, channelId: parsed.channelId, peerId: parsed.peerId };
    }
    // fs workspace: scope fields must be empty regardless of caller input.
    const next = { ...job };
    delete next.channelId;
    delete next.peerId;
    return next;
}

/** Is `actor` allowed to see `job`? The "admin" case (undefined actor)
 *  returns true — callers opt in to scoping by passing an actor. */
function isJobVisibleToActor(job: Job, actor: Actor): boolean {
    if (actor.kind === "im") {
        return job.channelId === actor.channelId && job.peerId === actor.peerId;
    }
    // IDE actor: must match the job's args.workspace exactly.
    const ws = typeof job.args.workspace === "string" ? job.args.workspace : "";
    return ws === actor.workspace;
}

/** Throws if `actor` (when present) cannot modify `job`. Mirrors
 *  `isJobVisibleToActor` but throws so write paths surface a clear error
 *  instead of silently no-op-ing. */
function assertActorMatchesJob(job: Job, actor: Actor | undefined): void {
    if (!actor) return;
    if (!isJobVisibleToActor(job, actor)) {
        throw new JobsScopeError("forbidden", `actor (${actor.kind}) cannot access job ${job.id}`);
    }
}
