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
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JobsControl } from "../runtime/serverRpcSurface.ts";
import type { Scheduler } from "./runner.ts";
import type { Job, JobHistoryEntry } from "./types.ts";

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

    async list(): Promise<Job[]> {
        return this.store.list();
    }

    async get(id: string): Promise<Job | null> {
        return this.store.get(id);
    }

    async create(job: Job): Promise<Job> {
        await this.store.save(job);
        // Re-load picks up the new copy; if `enabled`, the timer attaches.
        await this.scheduler.reload(job.id);
        return job;
    }

    async update(job: Job): Promise<Job> {
        await this.store.save(job);
        await this.scheduler.reload(job.id);
        return job;
    }

    async delete(id: string): Promise<void> {
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

    async runNow(id: string): Promise<boolean> {
        return this.scheduler.runNow(id);
    }

    async history(id: string): Promise<JobHistoryEntry[] | null> {
        const job = await this.store.get(id);
        return job?.history ?? null;
    }
}
