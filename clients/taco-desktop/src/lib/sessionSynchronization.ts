import type { SessionPushProcessor } from "./sessionPushProcessor";

// Navigation and live recovery share the transport's replay cursor and queue.
const processors = new WeakMap<object, SessionPushProcessor>();

export function bindSessionSynchronization(
    client: object,
    processor: SessionPushProcessor,
): () => void {
    processors.set(client, processor);
    return () => {
        if (processors.get(client) === processor) processors.delete(client);
    };
}

export function sessionSynchronization(client: object): SessionPushProcessor | undefined {
    return processors.get(client);
}
