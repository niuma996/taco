/** Token locks serialize Git and Taco metadata mutations across local Taco processes. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.ts";

const mutationContext = new AsyncLocalStorage<{ path: string; token: string }>();

const log = createLogger("worktree:lock");
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 25;

export interface WorktreeLockOptions {
    readonly timeoutMs?: number;
    readonly retryMs?: number;
}

export class WorktreeLockError extends Error {}

function missing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function removeOwner(path: string, token: string): Promise<void> {
    // A successor has a different token: a late release cannot unlink its owner.
    await unlink(join(path, token)).catch((error) => {
        if (!missing(error)) throw error;
    });
    await rmdir(path).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    });
}

async function reclaimDeadOwners(path: string): Promise<void> {
    let owners: string[];
    try {
        const entry = await lstat(path);
        if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new WorktreeLockError("Worktree repository lock storage is unsafe");
        owners = await readdir(path);
    } catch (error) {
        if (missing(error)) return;
        throw error;
    }
    // A killed sidecar may leave a Git child (and filters) running. Require manual
    // verification after an interrupted command rather than guessing from the parent PID.
    if (owners.some((owner) => owner.startsWith("git-active-"))) return;
    for (const owner of owners) {
        const pid = Number(/^(\d+)-[a-f0-9-]{36}$/.exec(owner)?.[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        try {
            process.kill(pid, 0);
        } catch (error) {
            // Age and missed heartbeats never prove a paused owner's Git child has stopped.
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
            // A command may have started between our first listing and the owner dying.
            const final = await readdir(path).catch((error: unknown) => {
                if (missing(error)) return [];
                throw error;
            });
            if (!final.some((name) => name.startsWith(`git-active-${owner}-`)))
                await removeOwner(path, owner);
        }
    }
    if (owners.length === 0)
        await rmdir(path).catch((error) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        });
}

export async function withWorktreeMutationLock<T>(
    commonDir: string,
    operation: () => Promise<T>,
    options: WorktreeLockOptions = {},
): Promise<T> {
    const path = join(commonDir, ".taco-worktree.lock");
    const token = `${process.pid}-${randomUUID()}`;
    const candidate = `${path}-${token}`;
    const deadline = performance.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await mkdir(candidate, { mode: 0o700 });
    let acquired = false;
    try {
        await writeFile(join(candidate, token), "", { mode: 0o600, flag: "wx" });
        for (;;) {
            try {
                // Publish owner and lock together; there is no ownerless acquisition window.
                await rename(candidate, path);
                acquired = true;
                break;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "")) throw error;
                await reclaimDeadOwners(path);
                if (performance.now() >= deadline)
                    throw new WorktreeLockError("Timed out acquiring the worktree repository lock");
                await new Promise((resolve) =>
                    setTimeout(resolve, options.retryMs ?? DEFAULT_RETRY_MS),
                );
            }
        }
        return await mutationContext.run({ path, token }, operation);
    } finally {
        const interrupted =
            acquired &&
            (
                await readdir(path).catch((error: unknown) => {
                    if (missing(error)) return [];
                    throw error;
                })
            ).some((name) => name.startsWith(`git-active-${token}-`));
        if (interrupted)
            log.warn(
                "interrupted Git command retained repository lock; verify Git processes before manual recovery",
            );
        else
            await removeOwner(acquired ? path : candidate, token).catch((error) =>
                log.warn("worktree repository lock release failed", String(error)),
            );
    }
}

/** Keep uncertain subprocess lifetimes visible after a sidecar crash or timeout. */
export async function withWorktreeGitCommand<T>(operation: () => Promise<T>): Promise<T> {
    const owner = mutationContext.getStore();
    if (!owner) return operation();
    const marker = join(owner.path, `git-active-${owner.token}-${randomUUID()}`);
    await writeFile(marker, "", { flag: "wx", mode: 0o600 });
    let settled = false;
    try {
        const result = await operation();
        settled = true;
        return result;
    } catch (error) {
        // Numeric exit codes mean Git and its inherited stdio have closed. Abort/timeout
        // can leave children behind, so the marker must outlive this rejected request.
        settled =
            typeof (error as { code?: unknown }).code === "number" ||
            (error as { code?: unknown }).code === "ENOENT";
        throw error;
    } finally {
        if (settled) await unlink(marker);
    }
}
