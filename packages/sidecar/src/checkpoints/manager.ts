/**
 * CheckpointManager — turn-scoped snapshot policy on top of CheckpointStore.
 *
 * A snapshot is taken before the first mutating tool call of a turn and covers
 * only files that turn is about to touch. Later writes in the same turn reuse
 * that checkpoint, so "undo" means "undo the whole turn" — the unit a user
 * actually thinks in, and far fewer snapshots than one per tool call.
 *
 * Because a path can be written later in the turn than it is first seen, each
 * newly-touched path is captured on first sight and merged into the turn's
 * existing checkpoint, preserving its pre-turn content.
 */

import type { CheckpointMeta, CheckpointStore } from "./store.ts";

/**
 * Maximum snapshot attempts per (turn, path). Past this we stop retrying for
 * the rest of the turn so a persistent I/O error doesn't log on every call.
 */
const MAX_CAPTURE_ATTEMPTS = 2;

export interface CheckpointManagerOptions {
    readonly store: CheckpointStore;
    readonly sessionId: string;
}

export class CheckpointManager {
    private readonly store: CheckpointStore;
    private readonly sessionId: string;
    private turnIndex = 0;
    /**
     * Paths whose snapshot succeeded this turn. A path is added before the
     * store call so a concurrent second call in the same turn is a no-op.
     */
    private capturedThisTurn = new Set<string>();
    /**
     * Paths whose snapshot failed and won't be retried this turn. Added after
     * `MAX_CAPTURE_ATTEMPTS` so a persistent I/O error doesn't log on every
     * mutating call.
     */
    private readonly failedThisTurn = new Set<string>();
    private turnStarted = false;

    constructor(options: CheckpointManagerOptions) {
        this.store = options.store;
        this.sessionId = options.sessionId;
    }

    /**
     * Drop the per-turn bookkeeping without declaring the turn over. Used when
     * the tree changed underneath us (a restore) but the turn is still running,
     * so `turnIndex` must not advance — the next capture still belongs to the
     * current turn and should be labelled as such.
     */
    private resetTurnState(): void {
        this.capturedThisTurn.clear();
        this.failedThisTurn.clear();
    }

    /**
     * Reset per-turn state. Called on `turn_end`, so the next mutating call
     * opens a fresh checkpoint rather than folding into the previous turn.
     */
    endTurn(): void {
        if (this.turnStarted) this.turnIndex++;
        this.turnStarted = false;
        this.resetTurnState();
    }

    /**
     * Snapshot `path` if this turn has not captured it yet. Safe to call before
     * every mutating tool call; repeated calls for the same path are no-ops.
     *
     * Never throws: a snapshot failure must not block the user's edit, so the
     * error is surfaced as a return value for the caller to log. After
     * `MAX_CAPTURE_ATTEMPTS` failures the path is parked for the rest of the
     * turn so a persistent error doesn't log on every call.
     */
    async captureBeforeWrite(path: string): Promise<{ ok: boolean; reason?: string }> {
        if (this.capturedThisTurn.has(path)) return { ok: true };
        if (this.failedThisTurn.has(path)) {
            return { ok: false, reason: "snapshot skipped after repeated failures this turn" };
        }
        this.turnStarted = true;
        let lastReason: string | undefined;
        for (let attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt++) {
            try {
                await this.store.create({
                    sessionId: this.sessionId,
                    label: `turn ${this.turnIndex + 1}`,
                    paths: [path],
                });
                this.capturedThisTurn.add(path);
                return { ok: true };
            } catch (e) {
                lastReason = e instanceof Error ? e.message : String(e);
            }
        }
        this.failedThisTurn.add(path);
        return { ok: false, reason: lastReason };
    }

    /**
     * Restore a checkpoint, snapshotting the current state of its files first
     * so the restore itself is undoable. The pre-restore snapshot is what
     * makes an accidental restore recoverable: an undo-target exists even
     * though the restore itself rewrites the tree.
     */
    async restore(id: string): Promise<{
        outcome: Awaited<ReturnType<CheckpointStore["restore"]>>;
        protection?: CheckpointMeta;
    }> {
        const target = await this.store.get(id);
        if (!target) throw new Error(`checkpoint not found: ${id}`);

        const protection = await this.store.create({
            sessionId: this.sessionId,
            label: `pre-restore of ${id}`,
            paths: target.files.map((f) => f.path),
        });

        const outcome = await this.store.restore(id);
        // The restored tree no longer matches what this turn captured, so drop
        // the bookkeeping: a later write to any of these paths must re-snapshot
        // rather than reuse a stale capture or hit the parking set. `turnIndex`
        // stays put — a restore is a user action that can land mid-turn, and
        // advancing it here would label the rest of this turn as the next one.
        this.resetTurnState();
        return { outcome, protection };
    }
}
