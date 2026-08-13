/**
 * Lightweight module-scoped pub-sub for `im.policy_changed` push events.
 *
 * App.tsx's useSidecarStream receives the push but can't easily reach a
 * deeply nested ImPolicyDialog inside ChannelsPane. This emitter lets the
 * stream handler fan out the event, and any open dialog (one per pane
 * instance) subscribes via subscribeImPolicyChanged and re-loads on match.
 *
 * Kept tiny on purpose: a typed EventTarget is overkill when the payload is a
 * single string. Direct dispatch + a Set of listeners is enough.
 */

const listeners = new Set<(channelId: string) => void>();

export function subscribeImPolicyChanged(handler: (channelId: string) => void): () => void {
    listeners.add(handler);
    return () => {
        listeners.delete(handler);
    };
}

export function onImPolicyChangedEvent(channelId: string): void {
    // Snapshot the listener set: handlers may subscribe/unsubscribe during
    // dispatch (e.g. effect cleanup of a re-mounting dialog), and JS Set
    // iteration semantics would otherwise pull in freshly-added listeners
    // mid-fanout. Snapshot keeps the iteration set stable.
    for (const listener of [...listeners]) listener(channelId);
}
