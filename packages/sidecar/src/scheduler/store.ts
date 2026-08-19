/**
 * File-backed job store. One JSON file per id under `<jobsDir>/<id>.json`.
 *
 * Writes go through `.tmp` + `rename` for atomicity (POSIX rename is
 * atomic; on Windows it fails across mount points, which is the same
 * tradeoff the desktop's `desktop_config_write` accepts — see lib.rs's
 * `desktop_config_write`). For the scheduler we don't expect cross-mount
 * layouts; TACO_HOME is a single directory tree by convention.
 *
 * Read paths tolerate missing files (returns []), malformed files (skip
 * with a warning), and unknown ids (returns null). The store is the
 * single source of truth; the in-memory `Scheduler.handles` map is a
 * cache rebuilt from disk on `start()`.
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JobAlreadyExistsError } from "../lib/jobsErrors.ts";
import { createLogger } from "../lib/logger.ts";
import { assertSafeJobId, isSafeJobId } from "./jobId.ts";
import type { Job } from "./types.ts";

const log = createLogger("sidecar.scheduler.store");

const JSON_INDENT = 2;

export class JobStore {
    private readonly queues = new Map<string, Promise<void>>();

    constructor(private readonly dir: string) {}

    /** Ensure the directory exists. Idempotent. */
    async ensureDir(): Promise<void> {
        await mkdir(this.dir, { recursive: true });
    }

    /** Read every <id>.json in `dir`, newest-write-first order is not
     *  guaranteed by readdir, so we sort by id for stable UI rendering.
     *  Skips files whose basename is not a safe job ID to contain path-
     *  traversal attempts that bypass the RPC layer. */
    async list(): Promise<Job[]> {
        await this.ensureDir();
        const entries = await readdir(this.dir, { withFileTypes: true }).catch(
            () => [] as Dirent[],
        );
        const jobs: Job[] = [];
        for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith(".json")) continue;
            const id = e.name.slice(0, -".json".length);
            if (!isSafeJobId(id)) continue;
            const job = await this.readOne(e.name, id);
            if (job) jobs.push(job);
        }
        return jobs.sort((a, b) => a.id.localeCompare(b.id));
    }

    async get(id: string): Promise<Job | null> {
        assertSafeJobId(id);
        return this.readOne(`${id}.json`, id);
    }

    /** Persist `job` atomically. Writes for one job are serialized and every
     *  write uses a unique temporary file, so concurrent saves cannot race. */
    async save(job: Job): Promise<void> {
        assertSafeJobId(job.id);
        await this.withJobQueue(job.id, () => this.write(job));
    }

    async create(job: Job): Promise<void> {
        assertSafeJobId(job.id);
        await this.withJobQueue(job.id, async () => {
            if (await this.readOne(`${job.id}.json`, job.id, false)) {
                throw new JobAlreadyExistsError(job.id);
            }
            await this.write(job);
        });
    }

    /** Serialized read-modify-write. Returning null deletes the job. */
    async mutate(id: string, update: (current: Job | null) => Job | null): Promise<Job | null> {
        assertSafeJobId(id);
        return this.withJobQueue(id, async () => {
            const current = await this.readOne(`${id}.json`, id, false);
            const next = update(current);
            if (next === current) return current;
            if (next === null) {
                await this.unlink(id);
                return null;
            }
            if (next.id !== id)
                throw new Error(`job mutation cannot change id ${id} -> ${next.id}`);
            await this.write(next);
            return next;
        });
    }

    async delete(id: string): Promise<void> {
        assertSafeJobId(id);
        await this.withJobQueue(id, () => this.unlink(id));
    }

    private async write(job: Job): Promise<void> {
        await this.ensureDir();
        const final = join(this.dir, `${job.id}.json`);
        const tmp = `${final}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(tmp, JSON.stringify(job, null, JSON_INDENT), "utf8");
            await rename(tmp, final);
        } finally {
            await unlink(tmp).catch(() => undefined);
        }
    }

    private async unlink(id: string): Promise<void> {
        const final = join(this.dir, `${id}.json`);
        await unlink(final).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
        });
    }

    private async withJobQueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(id) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.queues.set(id, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (this.queues.get(id) === tail) this.queues.delete(id);
        }
    }

    /** Best-effort read — skips malformed files (logs a warning) rather
     *  than throwing, so a single bad entry can't wedge the scheduler.
     *  When `id` is provided it has already been validated as safe; when
     *  omitted the basename is extracted from `name` and validated here. */
    private async readOne(name: string, id?: string, persistMigration = true): Promise<Job | null> {
        const path = join(this.dir, name);
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            log.warn(`failed to read ${path}: ${String(err)}`);
            return null;
        }
        try {
            const job = JSON.parse(raw) as Job;
            // Validate the id when not pre-validated (e.g. calls from get()).
            const extracted =
                id ?? (name.endsWith(".json") ? name.slice(0, -".json".length) : name);
            if (!isSafeJobId(extracted)) {
                log.warn(`skipping job with unsafe id ${JSON.stringify(extracted)} in ${path}`);
                return null;
            }
            // Older job files predate the `history` field; treat the absence
            // as an empty log so the runner's `[entry, ...job.history]`
            // spread never sees `undefined`. We still write the array back
            // (next save) so the file picks up the field naturally.
            const withHistory = job.history ? job : { ...job, history: [] };
            // Channel jobs (im:// workspace) only support
            // sessionStrategy="reuse". Files written before that rule —
            // or via the old schedules UI, whose strategy picker had no
            // "reuse" option and silently saved "pin" — carry a strategy
            // the dispatcher rejects on every fire. Coerce + persist so
            // the job self-heals on first read instead of needing a
            // manual edit. An absent field is left absent: the
            // dispatcher already defaults im:// to "reuse".
            const workspace =
                typeof withHistory.args?.workspace === "string" ? withHistory.args.workspace : "";
            const withStrategy =
                workspace.startsWith("im://") &&
                withHistory.sessionStrategy !== undefined &&
                withHistory.sessionStrategy !== "reuse"
                    ? { ...withHistory, sessionStrategy: "reuse" as const }
                    : withHistory;
            if (withStrategy !== withHistory && persistMigration) {
                await this.save(withStrategy).catch((err: unknown) =>
                    log.warn(`failed to persist strategy migration for ${path}: ${String(err)}`),
                );
            }
            // Older jobs also carried their intent in `command` (e.g.
            // `command: "mmx search query"`) instead of in `args.prompt`.
            // The dispatcher only routes `agent.invoke` — translate the
            // legacy shape so the next fire boots an agent session with a
            // useful initial prompt. Empty/non-string commands are left
            // alone; the dispatcher's unknown-command error will surface
            // them on the next fire rather than letting us silently drop
            // a job the user actually cared about.
            //
            // We also persist the migrated form back to disk so the file
            // picks up the canonical shape on first read. Without this,
            // the UI keeps showing the legacy `command` until something
            // else triggers a `save` — and a job nobody edits never gets
            // that opportunity. A write failure is logged but doesn't
            // break the read; the next read will retry the migration.
            if (
                typeof withStrategy.command === "string" &&
                withStrategy.command !== "agent.invoke"
            ) {
                const taskText = [withStrategy.command, ...positionalArgs(withStrategy.args)]
                    .join(" ")
                    .trim();
                if (taskText) {
                    const migrated = {
                        ...withStrategy,
                        command: "agent.invoke" as const,
                        args: { ...withStrategy.args, prompt: taskText },
                    };
                    if (persistMigration) {
                        await this.save(migrated).catch((err: unknown) =>
                            log.warn(`failed to persist migration for ${path}: ${String(err)}`),
                        );
                    }
                    return migrated;
                }
            }
            return withStrategy;
        } catch (err) {
            log.warn(`malformed job file ${path}: ${String(err)}`);
            return null;
        }
    }
}

/** Render a flat args bag as a short space-separated prompt tail. Skips
 *  noise keys (`output`, `quiet`, anything that isn't a primitive) so the
 *  migrated prompt stays focused on intent. */
function positionalArgs(args: Record<string, unknown> | undefined): string[] {
    if (!args) return [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null || value === "") continue;
        if (key === "prompt" || key === "workspace") continue;
        if (typeof value === "string") out.push(value);
    }
    return out;
}
