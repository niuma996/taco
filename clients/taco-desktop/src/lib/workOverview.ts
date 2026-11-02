/**
 * Pure state for the Work overview: grouping, response ordering, and the
 * decision of what a `work.changed` push means. No React, no client, so every
 * rule is testable without a daemon.
 *
 * The overview is a read-only view of the daemon's ledger. The daemon's answer
 * to `work.list` is the only source of truth; a push only says "look again".
 */

import type { WorkListResult, WorkSummary } from "@taco-ai/protocol";

export type WorkGroupId = "running" | "attention" | "finished";

export interface WorkGroups {
    running: WorkSummary[];
    attention: WorkSummary[];
    finished: WorkSummary[];
}

/**
 * Sort the daemon's two lists into the three groups the pane shows. `active`
 * holds both running Works and finished ones needing attention; they are told
 * apart by status, so the daemon's definition of "needs attention" stays the
 * only one.
 */
export function groupWork(
    active: readonly WorkSummary[],
    terminal: readonly WorkSummary[],
): WorkGroups {
    const running: WorkSummary[] = [];
    const attention: WorkSummary[] = [];
    for (const work of active) {
        if (work.status === "running" && !work.needsAttention) running.push(work);
        else attention.push(work);
    }
    return { running, attention, finished: [...terminal] };
}

/** What the pane holds between fetches. */
export interface WorkOverviewState {
    /** The daemon that produced `groups`; a different one means it was replaced. */
    instanceId: string | null;
    groups: WorkGroups;
    nextCursor: string | undefined;
    /** True after the first successful fetch; before it the pane shows a spinner, not "empty". */
    loaded: boolean;
}

export const EMPTY_WORK_STATE: WorkOverviewState = {
    instanceId: null,
    groups: { running: [], attention: [], finished: [] },
    nextCursor: undefined,
    loaded: false,
};

/** Replace the whole state from a first-page result. */
export function applyList(result: WorkListResult): WorkOverviewState {
    return {
        instanceId: result.instanceId,
        groups: groupWork(result.active, result.terminal),
        nextCursor: result.nextCursor,
        loaded: true,
    };
}

/**
 * Append a further page of finished Works. A row already shown is skipped, and
 * a page from another daemon is dropped: its cursor points into a ledger this
 * state no longer describes.
 */
export function appendPage(state: WorkOverviewState, page: WorkListResult): WorkOverviewState {
    if (state.instanceId !== page.instanceId) return state;
    const seen = new Set(
        [...state.groups.running, ...state.groups.attention, ...state.groups.finished].map(
            (w) => w.workId,
        ),
    );
    const fresh = page.terminal.filter((w) => !seen.has(w.workId));
    return {
        ...state,
        groups: { ...state.groups, finished: [...state.groups.finished, ...fresh] },
        nextCursor: page.nextCursor,
    };
}

/**
 * Orders asynchronous responses. Every request takes a ticket; only the newest
 * ticket's response may be applied, and `invalidate` retires every ticket at
 * once so a response issued before a reconnect cannot land after it.
 */
export class ResponseGate {
    private latest = 0;
    private floor = 0;

    /** Start a request. The returned function says whether its response is still wanted. */
    begin(): () => boolean {
        const ticket = ++this.latest;
        return () => ticket === this.latest && ticket > this.floor;
    }

    /** Retire everything in flight (connection changed, pane closed). */
    invalidate(): void {
        this.floor = this.latest;
    }
}

/**
 * Collapses a burst of triggers into one call after a quiet moment. Returns a
 * `cancel` for cleanup. The pane uses it so a dozen `work.changed` pushes in a
 * second cause one fetch.
 */
export function createCoalescer(
    run: () => void,
    waitMs: number,
): { trigger(): void; cancel(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        trigger() {
            if (timer !== undefined) return;
            timer = setTimeout(() => {
                timer = undefined;
                run();
            }, waitMs);
        },
        cancel() {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        },
    };
}
