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

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseImCwd } from "@taco-ai/protocol";
import type { ConversationRouter } from "../channels/conversationRouter.ts";
import { JobsScopeError } from "../lib/jobsErrors.ts";
import type { JobsControl } from "../runtime/serverRpcSurface.ts";
import { createJobId } from "./jobId.ts";
import type { Scheduler } from "./runner.ts";
import type { Actor, Job, JobHistoryEntry } from "./types.ts";

export class JobsController implements JobsControl {
    constructor(
        private readonly store: {
            list: () => Promise<Job[]>;
            get: (id: string) => Promise<Job | null>;
            // Required — every controller write goes through `mutate` so
            // the per-id write queue in JobStore serialises against
            // concurrent dispatcher callbacks (pin-session writes) and
            // the runner's history write. The earlier optional-fallback
            // path to `get + save` had the ABA problem `mutate` exists
            // to prevent.
            mutate: (
                id: string,
                update: (current: Job | null) => Job | null,
            ) => Promise<Job | null>;
            /** Kept for tests / admin paths that explicitly create a
             *  fresh job; not the controller's main write primitive. */
            create?: (job: Job) => Promise<void>;
            save?: (job: Job) => Promise<void>;
            delete: (id: string) => Promise<void>;
        },
        private readonly scheduler: Scheduler,
        private readonly lockDir: string,
        /** Reverse-only router index kept in sync with this controller's
         *  lifecycle: a pin job that disappears or switches strategy must
         *  drop its out-of-band session binding, otherwise the agent's
         *  reply would race into a deleted session or hijack the wrong
         *  peer's conversation. Optional for tests that don't load the
         *  channel stack. */
        private readonly conversationRouter?: Pick<ConversationRouter, "unregisterExternalSession">,
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
        const normalized = normalizeSessionStrategy(
            normalizeScopeFields({
                ...job,
                // RPC create clears caller-provided ids before reaching here. Keep
                // an explicit id for trusted internal callers/tests, while the
                // store's exclusive create still prevents replacement.
                id: job.id || createJobId(),
                generation: randomUUID(),
                history: [],
                last_run_at: undefined,
                next_run_at: undefined,
            }),
        );
        assertActorMatchesJob(normalized, actor);
        // create is preferred when supplied so we get the
        // already-exists guarantee (the controller's create path
        // throws JobAlreadyExistsError for duplicate ids instead of
        // silently overwriting). save is the fallback for backends
        // that only implement the broader write API.
        if (this.store.create) {
            await this.store.create(normalized);
        } else if (this.store.save) {
            await this.store.save(normalized);
        }
        // Re-load picks up the new copy; if `enabled`, the timer attaches.
        await this.scheduler.reload(normalized.id);
        return normalized;
    }

    async update(job: Job, actor?: Actor): Promise<Job> {
        const existing = await this.store.get(job.id);
        if (!existing) {
            throw new JobsScopeError("not_found", `job not found: ${job.id}`);
        }
        assertActorMatchesJob(existing, actor);
        // Capture the previous pinned id BEFORE the write so we can
        // unregister it on strategy flip. The new copy nulls
        // `pinnedSessionId` itself when sessionStrategy changes; here we
        // just need to know if there WAS a value to clean up.
        const previousPinned = existing.pinnedSessionId;
        // mutate is the canonical write boundary: the per-id queue in
        // JobStore serialises against concurrent dispatcher callbacks
        // and the runner's history write, so the closure sees the
        // latest committed job — never a stale snapshot.
        const saved = await this.store.mutate(job.id, (current) => {
            // The generation detects delete-and-recreate ABA: an update
            // that read the previous incarnation must never mutate a new
            // job that was recreated with the same trusted internal id.
            if (!current || current.generation !== existing.generation) {
                throw new JobsScopeError("not_found", `job not found: ${job.id}`);
            }
            // Build from the serialized store value, not the pre-mutation
            // snapshot. A pin callback or runner history write may have
            // landed while this update was waiting for the per-job queue.
            return normalizeSessionStrategy(
                normalizeScopeFields({
                    ...job,
                    args: { ...job.args, workspace: current.args.workspace },
                    channelId: current.channelId,
                    peerId: current.peerId,
                    generation: current.generation,
                    history: current.history,
                    last_run_at: current.last_run_at,
                    next_run_at: current.next_run_at,
                    sessionStrategy: job.sessionStrategy ?? current.sessionStrategy,
                    pinnedSessionId:
                        job.sessionStrategy !== undefined &&
                        job.sessionStrategy !== current.sessionStrategy
                            ? undefined
                            : current.pinnedSessionId,
                }),
            );
        });
        if (!saved) throw new JobsScopeError("not_found", `job not found: ${job.id}`);
        // Strategy flipped (e.g. pin → new) or the user removed the
        // pin entirely — the old pinned session is now orphaned from
        // the scheduler's point of view. Unregister its reverse-route
        // binding so it cannot address an IM reply to a peer it no
        // longer belongs to. We compare on the SAVED job (not the
        // pre-update `existing`) because a strategy match leaves the
        // pinned id intact; only a true change must drop it.
        if (
            previousPinned &&
            saved.sessionStrategy !== "pin" &&
            previousPinned !== saved.pinnedSessionId
        ) {
            this.conversationRouter?.unregisterExternalSession(previousPinned);
        }
        await this.scheduler.reload(saved.id);
        return saved;
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
        // If this job had pinned an out-of-band session, drop the
        // reverse-route binding before the store delete so a reply that
        // races the unlink can't address a session no scheduler will
        // ever re-pin. Safe to call on a non-IM / unpinned job — the
        // underlying map silently no-ops.
        if (existing.pinnedSessionId) {
            this.conversationRouter?.unregisterExternalSession(existing.pinnedSessionId);
        }
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
            await this.store
                .mutate(job.id, (current) => {
                    if (!current || current.generation !== job.generation) return current;
                    return { ...current, history: nextHistory };
                })
                .catch(() => undefined);
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

function normalizeSessionStrategy(job: Job): Job {
    const workspace = typeof job.args.workspace === "string" ? job.args.workspace : "";
    const isIm = workspace.startsWith("im://");
    const strategy = job.sessionStrategy ?? (isIm ? "reuse" : "pin");
    if (isIm && strategy !== "reuse") {
        throw new JobsScopeError("forbidden", 'channel jobs only support sessionStrategy="reuse"');
    }
    if (!isIm && strategy === "reuse") {
        throw new JobsScopeError("forbidden", "reuse strategy requires a channel workspace");
    }
    return { ...job, sessionStrategy: strategy };
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
