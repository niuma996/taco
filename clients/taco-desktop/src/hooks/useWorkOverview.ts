/**
 * useWorkOverview: loads the daemon's Work ledger for the overview pane.
 *
 * The list is process-scoped, so it does not depend on the active session —
 * only on a workspace being started (the transport needs one). Every path that
 * can make the pane's copy stale ends in the same `refresh`:
 *
 *  - entering the pane,
 *  - `work.changed` pushing a Work that moved (coalesced),
 *  - the daemon answering `initialize` again, which covers both a replaced
 *    daemon and a reconnect to the same one.
 *
 * `ResponseGate` keeps those from landing out of order: a slower answer to an
 * older request is dropped, never merged.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { subscribeWorkChanged } from "../lib/workEvents.ts";
import {
    appendPage,
    applyList,
    createCoalescer,
    EMPTY_WORK_STATE,
    ResponseGate,
    type WorkOverviewState,
} from "../lib/workOverview.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

/** How long a burst of `work.changed` pushes waits before one fetch. */
export const WORK_OVERVIEW_COALESCE_MS = 150;

export interface UseWorkOverviewResult {
    state: WorkOverviewState;
    loading: boolean;
    /** Loading a further page of finished Works. */
    loadingMore: boolean;
    error: string | null;
    /** Work id whose delivery is being re-sent, for the row's disabled state. */
    retryingId: string | null;
    refresh: () => void;
    /** Append the next page of finished Works. No-op on the last page. */
    loadMore: () => void;
    retryDelivery: (workId: string) => Promise<void>;
}

export function useWorkOverview(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseWorkOverviewResult {
    const [state, setState] = useState<WorkOverviewState>(EMPTY_WORK_STATE);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [retryingId, setRetryingId] = useState<string | null>(null);
    const { error, fail, clearError } = useAutoClearError();

    const stateRef = useRef(state);
    stateRef.current = state;
    const activeRef = useRef(active);
    activeRef.current = active;
    /** One gate for every request the pane issues; a newer one retires the rest. */
    const gateRef = useRef(new ResponseGate());

    const refresh = useCallback(() => {
        if (!activeRef.current) return;
        const isCurrent = gateRef.current.begin();
        setLoading(true);
        void client
            .workList({})
            .then((result) => {
                if (!isCurrent()) return;
                setState(applyList(result));
            })
            .catch((e: unknown) => {
                if (isCurrent()) fail(e);
            })
            .finally(() => {
                if (isCurrent()) setLoading(false);
            });
    }, [client, fail]);

    const loadMore = useCallback(() => {
        const cursor = stateRef.current.nextCursor;
        if (!activeRef.current || cursor === undefined) return;
        const isCurrent = gateRef.current.begin();
        setLoadingMore(true);
        void client
            .workList({ before: cursor })
            .then((result) => {
                if (!isCurrent()) return;
                setState((prev) => appendPage(prev, result));
            })
            .catch((e: unknown) => {
                if (isCurrent()) fail(e);
            })
            .finally(() => {
                if (isCurrent()) setLoadingMore(false);
            });
    }, [client, fail]);

    // One coalescer for pushes, reading the latest `refresh` through a ref so it
    // is created once and never re-subscribes downstream effects.
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    const coalescerRef = useRef<ReturnType<typeof createCoalescer> | null>(null);
    if (coalescerRef.current === null) {
        coalescerRef.current = createCoalescer(
            () => refreshRef.current(),
            WORK_OVERVIEW_COALESCE_MS,
        );
    }
    const coalescer = coalescerRef.current;

    /** The header's refresh button: a new look also dismisses the last failure. */
    const manualRefresh = useCallback(() => {
        clearError();
        refreshRef.current();
    }, [clearError]);

    useEffect(() => {
        const unsubscribe = subscribeWorkChanged(() => {
            // Any change means the whole overview may differ (a new Work, a
            // status flip, a delivery attempt), so the push always re-pulls.
            if (!activeRef.current) return;
            coalescer.trigger();
        });
        return () => {
            unsubscribe();
            coalescer.cancel();
        };
    }, [coalescer]);

    // Every successful handshake re-fetches: a replaced daemon has a different
    // ledger, and a reconnect to the same one may have missed pushes entirely.
    useEffect(() => {
        return client.onConnectionReady(() => {
            gateRef.current.invalidate();
            if (activeRef.current) coalescer.trigger();
        });
    }, [client, coalescer]);

    // `work.list` is process-scoped; it needs *a* started workspace as transport,
    // not this particular one. Depending on the cwd would refetch on every
    // workspace switch for no reason, and with no workspace at all the pane
    // would sit on a spinner it can never finish.
    const hasWorkspace = activeCwd !== undefined && activeCwd !== "";
    useEffect(() => {
        if (!active) return undefined;
        if (!hasWorkspace) {
            setState({ ...EMPTY_WORK_STATE, loaded: true });
            return undefined;
        }
        gateRef.current.invalidate();
        refreshRef.current();
        return () => gateRef.current.invalidate();
    }, [active, hasWorkspace]);

    const retryDelivery = useCallback(
        async (workId: string): Promise<void> => {
            setRetryingId(workId);
            clearError();
            try {
                const result = await client.workRetryDelivery({ workId });
                if (result.outcome !== "accepted") {
                    fail(new Error(result.outcome.replace("_", " ")));
                }
            } catch (e) {
                fail(e);
            } finally {
                setRetryingId(null);
                refreshRef.current();
            }
        },
        [client, clearError, fail],
    );

    return {
        state,
        loading,
        loadingMore,
        error,
        retryingId,
        refresh: manualRefresh,
        loadMore,
        retryDelivery,
    };
}
