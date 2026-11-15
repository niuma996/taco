/** Module-scoped fan-out for memory.changed pushes from the App-side stream. */
const listeners = new Set<(cwd: string) => void>();

export function subscribeMemoryChanged(handler: (cwd: string) => void): () => void {
    listeners.add(handler);
    return () => {
        listeners.delete(handler);
    };
}

export function onMemoryChangedEvent(cwd: string): void {
    for (const listener of [...listeners]) listener(cwd);
}
