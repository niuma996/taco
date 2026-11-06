import { AsyncLocalStorage } from "node:async_hooks";

const origin = new AsyncLocalStorage<string>();

/** Trusted tool runtime identity, scoped to this async RPC call and its descendants. */
export function withMemoryWriteOrigin<T>(
    sessionId: string,
    callback: () => Promise<T>,
): Promise<T> {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("memory write origin requires a non-blank session id");
    }
    return origin.run(sessionId, callback);
}

/** Public RPC params cannot establish a memory write origin. */
export function currentMemoryWriteOrigin(): string | undefined {
    return origin.getStore();
}
