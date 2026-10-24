import { useEffect, useState } from "react";

/**
 * `active`, but only once it has stayed true for `delayMs`. Drops to false the
 * moment `active` does.
 *
 * For loading indicators: a load that settles inside the delay never shows
 * one, so a fast swap reads as a swap instead of a flash of placeholder.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (!active) {
            setShown(false);
            return;
        }
        const timer = setTimeout(() => setShown(true), delayMs);
        return () => clearTimeout(timer);
    }, [active, delayMs]);
    return active && shown;
}
