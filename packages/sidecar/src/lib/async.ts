/**
 * waitForEvent — resolve when a one-shot signal fires, or time out.
 *
 * The caller adapts its own event source via `subscribe` (which returns the
 * matching `unsubscribe`). `cancel()` ends the wait early with `false` — used
 * when the operation that would produce the signal fails on another path.
 */

export interface WaitForEventOptions {
    timeoutMs: number;
    subscribe: (listener: () => void) => () => void;
}

export interface WaitForEvent {
    promise: Promise<boolean>;
    cancel: () => void;
}

export function waitForEvent(opts: WaitForEventOptions): WaitForEvent {
    let resolve!: (received: boolean) => void;
    const promise = new Promise<boolean>((res) => {
        resolve = res;
    });
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const listener = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), opts.timeoutMs);
    const finish = (received: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(received);
    };
    unsubscribe = opts.subscribe(listener);
    // If subscribe fired the listener synchronously, finish() already ran with
    // unsubscribe still undefined — clean up now that we hold it.
    if (settled) unsubscribe?.();
    return { promise, cancel: () => finish(false) };
}

/**
 * Single-flight a per-key async factory. Concurrent calls for the same key
 * share one in-flight promise; later calls after the promise resolves or
 * rejects retry the factory (failures are not cached).
 *
 * The map entry is cleared exactly once the shared promise settles, so a
 * rejection does not poison subsequent callers — they get a fresh attempt.
 *
 * Used by SidecarServer.ensureWorkspace to keep N concurrent RPCs from
 * running the cold-start path (asset loading, MCP discovery, push wiring)
 * more than once for the same workspace.
 */
export class SingleFlight<K, V> {
    private readonly inflight = new Map<K, Promise<V>>();
    constructor(private readonly factory: (key: K) => Promise<V>) {}

    async run(key: K): Promise<V> {
        const cached = this.inflight.get(key);
        if (cached) return cached;
        const work = this.factory(key);
        this.inflight.set(key, work);
        // Drop the entry once the shared promise settles, but only if it
        // still points to the same promise — a new run() between here and
        // the resolution may have replaced it. Using .then with an empty
        // rejection handler instead of .finally avoids creating a follow-up
        // rejection when `work` itself rejects (Promise.prototype.finally
        // returns a new promise that rejects with the same reason).
        work.then(
            () => {
                if (this.inflight.get(key) === work) this.inflight.delete(key);
            },
            () => {
                if (this.inflight.get(key) === work) this.inflight.delete(key);
            },
        );
        return work;
    }

    /** Drop every in-flight promise. Awaiters will observe whatever the
     *  factory already threw, not a cancelled value. */
    clear(): void {
        this.inflight.clear();
    }
}
