/**
 * Shared Pele module for Mermaid diagrams, usable synchronously once loaded.
 *
 * Pele stays in its own lazily loaded chunk, but a diagram must not wait for
 * that chunk when it mounts: until the module is in, the block shows its
 * source, and swapping source for the rendered SVG resizes the message and
 * shoves the text below it. So the chunk is preloaded while the app is idle,
 * and once it is in, diagrams render synchronously (about 1ms each) and paint
 * at their final size.
 *
 * Readiness is a version counter for `useSyncExternalStore`, so a diagram
 * mounted before the chunk arrived re-renders to pick it up.
 */

type PeleModule = typeof import("pele");

let pele: PeleModule | null = null;
let loading = false;
let version = 0;
const listeners = new Set<() => void>();

function load(): void {
    if (loading) return;
    loading = true;
    import("pele")
        .then((mod) => {
            pele = mod;
            version++;
            for (const listener of listeners) listener();
        })
        .catch((err) => {
            // Allow a later diagram to retry instead of staying on the source forever.
            loading = false;
            console.warn("[taco] pele failed to load; diagram view unavailable", err);
        });
}

export function subscribePele(listener: () => void): () => void {
    load();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Bumps once, when the module becomes available. */
export function getPeleVersion(): number {
    return version;
}

/** The module, or null while it is still loading (or failed to). */
export function getPele(): PeleModule | null {
    return pele;
}

let preloadScheduled = false;

/**
 * Fetch the chunk once the app is idle, so the first diagram in a session
 * already has it. Safe to call repeatedly.
 */
export function preloadPeleWhenIdle(): void {
    if (preloadScheduled || pele) return;
    preloadScheduled = true;
    // WKWebView lacks requestIdleCallback; a short timeout keeps the fetch off
    // the open-session critical path all the same.
    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(load, { timeout: 2000 });
    } else {
        setTimeout(load, 500);
    }
}
