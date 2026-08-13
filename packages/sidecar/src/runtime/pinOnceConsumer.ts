/**
 * PinOnceConsumer — tracks which pinOnce tag instances have been consumed
 * during the first compaction, so context hooks can skip re-injecting them.
 *
 * The consumed set is reconstructed from session history on construction,
 * merged from past `CompactionEntry.details.consumedPinOnceInstances`. This
 * means the consumer is accurate even after an AttachedSession restart.
 */

import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";

/** Persisted shape stored in `CompactionEntry.details`. */
export interface PinOnceConsumedDetails {
    readonly consumedPinOnceInstances: readonly string[];
}

/** Read `consumedPinOnceInstances` from a CompactionEntry's details. */
function readConsumed(entry: SessionTreeEntry): readonly string[] {
    if (entry.type !== "compaction") return [];
    const details = (entry as { details?: unknown }).details as PinOnceConsumedDetails | undefined;
    return details?.consumedPinOnceInstances ?? [];
}

/**
 * Rebuild the full consumed set from session history.
 * Called once at AttachedSession construction time.
 */
function rebuildConsumedSet(entries: SessionTreeEntry[]): Set<string> {
    const consumed = new Set<string>();
    for (const entry of entries) {
        for (const id of readConsumed(entry)) {
            consumed.add(id);
        }
    }
    return consumed;
}

export class PinOnceConsumer {
    private readonly consumed: Set<string>;

    constructor(entries: SessionTreeEntry[] = []) {
        this.consumed = rebuildConsumedSet(entries);
    }

    /** True if this instanceId has already been consumed by a past compaction. */
    isConsumed(instanceId: string): boolean {
        return this.consumed.has(instanceId);
    }

    /**
     * Merge consumed instanceIds from a CompactionEntry into the set.
     * Called when a compaction completes (e.g. via session_compact event).
     */
    mergeConsumed(entries: SessionTreeEntry[]): void {
        for (const entry of entries) {
            for (const id of readConsumed(entry)) {
                this.consumed.add(id);
            }
        }
    }
}
