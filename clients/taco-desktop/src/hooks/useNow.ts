/**
 * Shared clock for relative timestamps.
 *
 * One interval for every subscriber, so a long message list does not start a
 * timer per row. 30s is coarse enough that the list does not re-render every
 * second, and fine enough that "2 minutes ago" does not sit stale.
 */
import { useEffect, useState } from "react";

const TICK_MS = 30_000;

const listeners = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick(): void {
    const now = Date.now();
    for (const listener of listeners) listener(now);
}

function ensureTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(tick, TICK_MS);
}

function stopTimer(): void {
    if (timer === undefined || listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
}

export function useNow(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        listeners.add(setNow);
        ensureTimer();
        return () => {
            listeners.delete(setNow);
            stopTimer();
        };
    }, []);
    return now;
}
