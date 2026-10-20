/**
 * Lightweight module-scoped pub-sub for `workspace.associations_changed` push
 * events.
 *
 * The push reaches App.tsx's useSidecarStream, which cannot easily reach the
 * associations dialog. This emitter fans the event out; an open dialog
 * subscribes and re-loads on a key match.
 *
 * Same shape as `imPolicyEvents.ts` — a typed EventTarget is overkill for a
 * single object payload, so a Set of listeners is enough.
 */

import type { WorkspaceAssociationKey } from "@taco-ai/protocol";

const listeners = new Set<(key: WorkspaceAssociationKey) => void>();

export function subscribeWorkspaceAssociationsChanged(
    handler: (key: WorkspaceAssociationKey) => void,
): () => void {
    listeners.add(handler);
    return () => {
        listeners.delete(handler);
    };
}

export function onWorkspaceAssociationsChangedEvent(key: WorkspaceAssociationKey): void {
    // Snapshot the listener set: handlers may subscribe/unsubscribe during
    // dispatch (effect cleanup of a re-mounting dialog), and JS Set
    // iteration semantics would otherwise pull in freshly-added listeners
    // mid-fanout.
    for (const listener of [...listeners]) listener(key);
}
