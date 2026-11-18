/**
 * Process-local serialization for read-modify-write checkpoint indexes.
 * Multiple checkpoint stores can point at one index when workspaces share an
 * execution directory, so the lock belongs to the canonical index path rather
 * than to a store instance.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const chains = new Map<string, Promise<void>>();

/**
 * Use the same lock for spelling variants of one index path. The index itself
 * may not exist on the first write, so resolve the nearest existing ancestor
 * before appending the missing path components.
 */
function checkpointIndexKey(indexPath: string): string {
    let cursor = resolve(indexPath);
    const suffix: string[] = [];
    while (!existsSync(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor) {
            const fallback = resolve(indexPath);
            return process.platform === "win32" ? fallback.toLowerCase() : fallback;
        }
        suffix.unshift(basename(cursor));
        cursor = parent;
    }
    const canonical = join(realpathSync.native(cursor), ...suffix);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function enqueueCheckpointIndexWrite<T>(
    indexPath: string,
    operation: () => Promise<T>,
): Promise<T> {
    const key = checkpointIndexKey(indexPath);
    const previous = chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
        () => undefined,
        () => undefined,
    );
    chains.set(key, settled);
    void settled.then(() => {
        if (chains.get(key) === settled) chains.delete(key);
    });
    return current;
}

export async function waitForCheckpointIndex(indexPath: string): Promise<void> {
    await (chains.get(checkpointIndexKey(indexPath)) ?? Promise.resolve());
}
