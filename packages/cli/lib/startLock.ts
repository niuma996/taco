import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// READY_TIMEOUT_MS is 5s and a failed waitForSocket kills the child, so a healthy
// holder releases in ≲6s; 15s is 2.5× headroom for cold starts on slow disks while
// still reclaiming a kill -9'd holder inside the window a human would spend retrying.
export const START_LOCK_TTL_MS = 15_000;

interface LockState {
    pid: number;
    acquiredAt: number;
}

export interface StartLockHandle {
    readonly path: string;
    release(): Promise<void>;
}

export async function readStartLock(path: string): Promise<LockState | null> {
    try {
        const content = await readFile(path, "utf8");
        const parsed = JSON.parse(content);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            typeof parsed.pid === "number" &&
            typeof parsed.acquiredAt === "number"
        ) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

export async function acquireStartLock(
    runDir: string,
    now: () => number = Date.now,
): Promise<StartLockHandle | null> {
    const lockPath = join(runDir, "start.lock");

    // Ensure the directory exists
    await mkdir(runDir, { recursive: true });

    const lockData = { pid: process.pid, acquiredAt: now() };
    const lockContent = JSON.stringify(lockData);

    // Attempt to write with exclusive flag
    let acquired = false;
    try {
        await writeFile(lockPath, lockContent, { flag: "wx", encoding: "utf8" });
        acquired = true;
    } catch (err) {
        // If file already exists, check if it's stale
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            const existing = await readStartLock(lockPath);

            // Determine if the lock is stale
            const isStale = existing === null || now() - existing.acquiredAt > START_LOCK_TTL_MS;

            if (isStale) {
                // Try to reclaim: unlink and retry once
                try {
                    await unlink(lockPath);
                } catch {
                    // If unlink fails, someone else may have already reclaimed it
                }

                try {
                    await writeFile(lockPath, lockContent, {
                        flag: "wx",
                        encoding: "utf8",
                    });
                    acquired = true;
                } catch (retryErr) {
                    // If retry also fails with EEXIST, we lost the race
                    if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
                        return null;
                    }
                    throw retryErr;
                }
            } else {
                // Lock is not stale, so we cannot acquire it
                return null;
            }
        } else {
            throw err;
        }
    }

    if (!acquired) {
        return null;
    }

    return {
        path: lockPath,
        async release(): Promise<void> {
            try {
                await unlink(lockPath);
            } catch (err) {
                // Swallow ENOENT errors; idempotent release
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw err;
                }
            }
        },
    };
}
