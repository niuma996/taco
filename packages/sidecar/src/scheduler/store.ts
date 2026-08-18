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

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.ts";
import { assertSafeJobId, isSafeJobId } from "./jobId.ts";
import type { Job } from "./types.ts";

const log = createLogger("sidecar.scheduler.store");

const TMP_SUFFIX = ".tmp";
const JSON_INDENT = 2;

export class JobStore {
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

    /** Persist `job` atomically: write `<id>.json.tmp`, then rename. */
    async save(job: Job): Promise<void> {
        await this.ensureDir();
        assertSafeJobId(job.id);
        const final = join(this.dir, `${job.id}.json`);
        const tmp = `${final}${TMP_SUFFIX}`;
        await writeFile(tmp, JSON.stringify(job, null, JSON_INDENT), "utf8");
        await rename(tmp, final);
    }

    async delete(id: string): Promise<void> {
        assertSafeJobId(id);
        const final = join(this.dir, `${id}.json`);
        await unlink(final).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== "ENOENT") throw err;
        });
    }

    /** Best-effort read — skips malformed files (logs a warning) rather
     *  than throwing, so a single bad entry can't wedge the scheduler.
     *  When `id` is provided it has already been validated as safe; when
     *  omitted the basename is extracted from `name` and validated here. */
    private async readOne(name: string, id?: string): Promise<Job | null> {
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
            if (typeof withHistory.command === "string" && withHistory.command !== "agent.invoke") {
                const taskText = [withHistory.command, ...positionalArgs(withHistory.args)]
                    .join(" ")
                    .trim();
                if (taskText) {
                    const migrated = {
                        ...withHistory,
                        command: "agent.invoke" as const,
                        args: { ...withHistory.args, prompt: taskText },
                    };
                    await this.save(migrated).catch((err: unknown) =>
                        log.warn(`failed to persist migration for ${path}: ${String(err)}`),
                    );
                    return migrated;
                }
            }
            return withHistory;
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
