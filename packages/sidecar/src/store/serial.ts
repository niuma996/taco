/**
 * In-process serialization primitives for the sidecar's document stores.
 *
 * These only order operations within one process. They are not cross-process
 * locks: a daemon and a stdio sidecar can touch the same tree, and only
 * `ConfigStore` / `WorkspaceAssociationStore` guard against that.
 */

/** One FIFO chain shared by every operation on a store. */
export class SerialChain {
    private tail: Promise<unknown> = Promise.resolve();

    run<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.catch(() => undefined).then(operation);
        this.tail = result;
        return result;
    }
}

/** One FIFO chain per key; different keys proceed concurrently. */
export class KeyedQueue {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.tails.set(key, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (this.tails.get(key) === tail) this.tails.delete(key);
        }
    }
}
