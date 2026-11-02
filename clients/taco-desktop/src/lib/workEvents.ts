/**
 * Module-scoped pub-sub for the `work.changed` push.
 *
 * The push arrives at App.tsx's stream hook, but the Work pane mounts later and
 * may not be open at all. Handing the event through a module emitter (the same
 * shape as `imPolicyEvents.ts`) means the pane subscribes when it mounts and
 * the App-level wiring never needs to know about it.
 */

import type { WorkChangedParams } from "@taco-ai/protocol";

const listeners = new Set<(params: WorkChangedParams) => void>();

export function subscribeWorkChanged(handler: (params: WorkChangedParams) => void): () => void {
    listeners.add(handler);
    return () => {
        listeners.delete(handler);
    };
}

export function onWorkChangedEvent(params: WorkChangedParams): void {
    // Snapshot: a handler may unsubscribe while this fan-out is running.
    for (const listener of [...listeners]) listener(params);
}
