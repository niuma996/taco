/** Cross-process lease lock for mutations of one repository's shared Git metadata. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 25;

interface Owner {
    pid: number;
    token: string;
    expiresAt: string;
}

export interface WorktreeLockOptions {
    readonly leaseMs?: number;
    readonly timeoutMs?: number;
    readonly retryMs?: number;
}

function lockPath(commonDir: string): string {
    return join(commonDir, ".taco-worktree.lock");
}

function isExpired(owner: Owner, now = Date.now()): boolean {
    const expires = Date.parse(owner.expiresAt);
    return !Number.isFinite(expires) || expires <= now;
}

function ownerIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return pid === process.pid;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function readOwner(path: string): Promise<Owner | undefined> {
    try {
        const value: unknown = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
        if (
            !value ||
            typeof value !== "object" ||
            typeof (value as Owner).pid !== "number" ||
            typeof (value as Owner).token !== "string" ||
            typeof (value as Owner).expiresAt !== "string"
        )
            return undefined;
        return value as Owner;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return undefined;
    }
}

async function reclaimIfStale(path: string, leaseMs: number): Promise<void> {
    const owner = await readOwner(path);
    if (owner && !isExpired(owner) && ownerIsAlive(owner.pid)) return;
    if (!owner) {
        const metadata = await stat(path).catch(() => undefined);
        if (metadata && Date.now() - metadata.mtimeMs < leaseMs) return;
    }
    await rm(path, { recursive: true, force: true });
}

async function acquire(
    commonDir: string,
    options: Required<WorktreeLockOptions>,
): Promise<{ path: string; owner: Owner }> {
    const path = lockPath(commonDir);
    const owner: Owner = {
        pid: process.pid,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + options.leaseMs).toISOString(),
    };
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        try {
            await mkdir(path);
            await writeFile(join(path, "owner.json"), JSON.stringify(owner), {
                encoding: "utf8",
                mode: 0o600,
                flag: "wx",
            });
            return { path, owner };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            await reclaimIfStale(path, options.leaseMs);
            if (Date.now() >= deadline)
                throw new Error("Timed out acquiring the worktree repository lock");
            await new Promise((resolve) => setTimeout(resolve, options.retryMs));
        }
    }
}

export async function withWorktreeMutationLock<T>(
    commonDir: string,
    operation: () => Promise<T>,
    suppliedOptions: WorktreeLockOptions = {},
): Promise<T> {
    const options: Required<WorktreeLockOptions> = {
        leaseMs: suppliedOptions.leaseMs ?? DEFAULT_LEASE_MS,
        timeoutMs: suppliedOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retryMs: suppliedOptions.retryMs ?? DEFAULT_RETRY_MS,
    };
    const { path, owner } = await acquire(commonDir, options);
    const heartbeat = setInterval(
        () => {
            owner.expiresAt = new Date(Date.now() + options.leaseMs).toISOString();
            void writeFile(join(path, "owner.json"), JSON.stringify(owner), "utf8").catch(
                () => undefined,
            );
        },
        Math.max(1, Math.floor(options.leaseMs / 3)),
    );
    heartbeat.unref?.();
    try {
        return await operation();
    } finally {
        clearInterval(heartbeat);
        const current = await readOwner(path);
        if (current?.token === owner.token) await rm(path, { recursive: true, force: true });
    }
}
