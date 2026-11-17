/**
 * Process-local serialization for read-modify-write checkpoint indexes.
 * Multiple checkpoint stores can point at one index when workspaces share an
 * execution directory, so the lock belongs to the canonical index path rather
 * than to a store instance.
 */

const chains = new Map<string, Promise<void>>();

export function enqueueCheckpointIndexWrite<T>(
    indexPath: string,
    operation: () => Promise<T>,
): Promise<T> {
    const previous = chains.get(indexPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
        () => undefined,
        () => undefined,
    );
    chains.set(indexPath, settled);
    void settled.then(() => {
        if (chains.get(indexPath) === settled) chains.delete(indexPath);
    });
    return current;
}

export async function waitForCheckpointIndex(indexPath: string): Promise<void> {
    await (chains.get(indexPath) ?? Promise.resolve());
}
