import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { TacoGlobalConfigShape } from "@taco-ai/protocol";
import { restrictOwnerSync } from "../lib/fsPermissions.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("config");
const LOCK_TIMEOUT_MS = 1000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
// Only finished transactions may retry cleanup; an active same-process lock stays exclusive.
const pendingReleases = new Set<() => void>();
// Tokens of transactions live in this process. A same-PID token outside this set
// was left by a previous process whose PID was reused and can be reclaimed.
const liveLockTokens = new Set<string>();

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Synchronous transactions serialize writers across instances and processes. */
export class ConfigStore {
    private cache?: { path: string; stamp: string; config: TacoGlobalConfigShape };

    read(path: string): TacoGlobalConfigShape {
        let stamp: string;
        try {
            const stat = statSync(path, { bigint: true });
            stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch (error) {
            if (!missing(error)) throw error;
            this.cache = undefined;
            return {};
        }
        if (this.cache?.path === path && this.cache.stamp === stamp) return this.cache.config;
        const config = this.readDisk(path);
        this.cache = { path, stamp, config };
        return config;
    }

    update(
        path: string,
        mutate: (current: TacoGlobalConfigShape) => TacoGlobalConfigShape,
    ): TacoGlobalConfigShape {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const release = this.lock(path);
        const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
        try {
            // Always read inside the lock; a process-local cache is not a transaction snapshot.
            const next = mutate(this.readDisk(path));
            writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            });
            restrictOwnerSync(tmp);
            renameSync(tmp, path);
            this.cache = undefined;
            return next;
        } finally {
            try {
                unlinkSync(tmp);
            } catch (error) {
                if (!missing(error))
                    log.warn("failed to clean config temporary file", {
                        path: tmp,
                        error: String(error),
                    });
            } finally {
                try {
                    release();
                } catch (error) {
                    pendingReleases.add(release);
                    log.warn("failed to release config lock", { path, error: String(error) });
                }
            }
        }
    }

    private readDisk(path: string): TacoGlobalConfigShape {
        let raw: string;
        try {
            raw = readFileSync(path, "utf8");
        } catch (error) {
            if (missing(error)) return {};
            log.error(`failed to read config ${path}:`, error);
            throw error;
        }
        try {
            return JSON.parse(raw) as TacoGlobalConfigShape;
        } catch (error) {
            log.error(`failed to read config ${path}:`, error);
            throw error;
        }
    }

    private lock(path: string): () => void {
        for (const release of pendingReleases) {
            try {
                release();
                pendingReleases.delete(release);
            } catch {
                // Keep the owner token for another retry after filesystem recovery.
            }
        }
        const lock = `${path}.lock`;
        const token = `${process.pid}-${randomUUID()}`;
        liveLockTokens.add(token);
        const candidate = `${lock}-${token}`;
        mkdirSync(candidate, { mode: 0o700 });
        let acquired = false;
        try {
            writeFileSync(`${candidate}/${token}`, "", { mode: 0o600, flag: "wx" });
            const deadline = performance.now() + LOCK_TIMEOUT_MS;
            for (;;) {
                try {
                    // Publish a nonempty directory atomically: no ownerless creation window.
                    renameSync(candidate, lock);
                    acquired = true;
                    return () => {
                        try {
                            this.removeOwner(lock, token);
                        } finally {
                            liveLockTokens.delete(token);
                        }
                    };
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (
                        code !== "EEXIST" &&
                        code !== "ENOTEMPTY" &&
                        !((code === "EPERM" || code === "EACCES") && existsSync(lock))
                    )
                        throw error;
                }
                if (performance.now() >= deadline) {
                    throw new Error(
                        `Timed out acquiring config lock: ${lock} (remove it if no taco process is running)`,
                    );
                }
                let owners: string[];
                try {
                    owners = readdirSync(lock);
                } catch (error) {
                    if (missing(error)) continue;
                    throw error;
                }
                if (owners.length === 0) {
                    try {
                        rmdirSync(lock);
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code;
                        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST")
                            throw error;
                    }
                    continue;
                }
                for (const owner of owners) this.reclaimIfDead(lock, owner);
                // The public API is synchronous; keep main-thread contention bounded.
                Atomics.wait(waitBuffer, 0, 0, 10);
            }
        } finally {
            if (!acquired) {
                liveLockTokens.delete(token);
                try {
                    this.removeOwner(candidate, token);
                } catch (error) {
                    pendingReleases.add(() => this.removeOwner(candidate, token));
                    log.warn("failed to clean config lock candidate", {
                        path: candidate,
                        error: String(error),
                    });
                }
            }
        }
    }

    private reclaimIfDead(lock: string, owner: string): void {
        const pid = Number(/^(\d+)-/.exec(owner)?.[1]);
        if (!Number.isInteger(pid) || pid <= 0) return;
        if (pid === process.pid) {
            if (!liveLockTokens.has(owner)) this.removeOwner(lock, owner);
            return;
        }
        try {
            process.kill(pid, 0);
        } catch (error) {
            // EPERM still means a live owner. Age alone never permits stealing.
            if ((error as NodeJS.ErrnoException).code === "ESRCH") this.removeOwner(lock, owner);
        }
    }

    private removeOwner(lock: string, token: string): void {
        try {
            unlinkSync(`${lock}/${token}`);
        } catch (error) {
            if (!missing(error)) throw error;
        }
        try {
            // A successor's nonempty directory cannot be removed by a stale releaser.
            rmdirSync(lock);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        }
    }
}
