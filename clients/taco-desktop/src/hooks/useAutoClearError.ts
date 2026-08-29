/**
 * useAutoClearError — one transient error slot for a pane.
 *
 * Panes surface RPC failures as a message that disappears on its own, so the
 * user isn't left dismissing stale banners after the next action already
 * succeeded. This centralizes three behaviours that were previously copied per
 * hook and had drifted apart:
 *
 *  - `unknown` → string via an `instanceof Error` check. A bare
 *    `(e as Error).message` renders "undefined" when a non-Error is thrown
 *    (a rejected string, a DOMException-like object), which is worse than the
 *    stringified value.
 *  - a single pending timer: a second failure restarts the window instead of
 *    letting the first one's timer clear the newer message early.
 *  - cleanup on unmount, so a pane closed inside the window doesn't set state
 *    on an unmounted component.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a transient pane error stays on screen. */
export const PANE_ERROR_CLEAR_MS = 4000;

export interface UseAutoClearErrorResult {
    error: string | null;
    /** Record a failure; clears itself after PANE_ERROR_CLEAR_MS. */
    fail: (e: unknown) => void;
    /** Clear now — call before starting a request so stale text doesn't linger. */
    clearError: () => void;
}

export function useAutoClearError(): UseAutoClearErrorResult {
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<number | undefined>(undefined);

    const cancelTimer = useCallback(() => {
        if (timerRef.current !== undefined) {
            window.clearTimeout(timerRef.current);
            timerRef.current = undefined;
        }
    }, []);

    // Unmount only: a pending timer must not fire into a dead component.
    useEffect(() => cancelTimer, [cancelTimer]);

    const clearError = useCallback(() => {
        cancelTimer();
        setError(null);
    }, [cancelTimer]);

    const fail = useCallback(
        (e: unknown) => {
            cancelTimer();
            setError(e instanceof Error ? e.message : String(e));
            timerRef.current = window.setTimeout(() => {
                timerRef.current = undefined;
                setError(null);
            }, PANE_ERROR_CLEAR_MS);
        },
        [cancelTimer],
    );

    return { error, fail, clearError };
}
