/**
 * Creates a small latest-request-wins guard for async UI actions.
 * Starting or explicitly invalidating a request makes all older checks false.
 */
export function createLatestRequestGuard(): {
    begin: () => () => boolean;
    invalidate: () => void;
} {
    let generation = 0;

    return {
        begin: () => {
            const requestGeneration = ++generation;
            return () => requestGeneration === generation;
        },
        invalidate: () => {
            generation += 1;
        },
    };
}
