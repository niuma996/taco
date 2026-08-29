/**
 * useStableCallback — wraps a callback into a reference-stable function.
 *
 * Purpose: before React 19's useEvent / useEffectEvent, wrapping a callback in a ref lets
 * effects / memo deps stay stable without rebuilding the listener on every render.
 *
 * Usage:
 *   const stableOnAction = useStableCallback(onAction);
 *   useEffect(() => { ... }, [stableOnAction]);
 */
import { useCallback, useRef } from "react";

export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
    const ref = useRef(fn);
    ref.current = fn;
    return useCallback((...args: Parameters<T>) => ref.current(...args), []) as T;
}
