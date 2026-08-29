/**
 * useRetryOnError — bounded automatic retry with exponential back-off after fetch failures.
 *
 * Handles the cold-start timing mismatch where an RPC fires before the sidecar is ready,
 * causing a permanent block. Retries fire on error, stop automatically on success
 * (error → null), and reset the back-off cycle. Back-off: 1s/2s/4s/… up to 8s, capped
 * at MAX_ATTEMPTS consecutive failures.
 *
 * Attempt count is preserved across consecutive failures. A retry() failure creates a new
 * Error, re-running the effect without resetting the counter; only success (error → null)
 * starts a fresh retry window.
 */
import { useEffect, useRef } from "react";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

export function useRetryOnError(error: Error | null, retry: () => void): void {
    const retryRef = useRef(retry);
    const attemptsRef = useRef(0);
    retryRef.current = retry;

    useEffect(() => {
        if (!error) {
            attemptsRef.current = 0;
            return;
        }
        if (attemptsRef.current >= MAX_ATTEMPTS) return;

        attemptsRef.current += 1;
        const delay = Math.min(BASE_DELAY_MS * 2 ** (attemptsRef.current - 1), MAX_DELAY_MS);
        const timer = setTimeout(() => retryRef.current(), delay);

        return () => {
            clearTimeout(timer);
        };
    }, [error]);
}
