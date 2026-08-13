/**
 * Text range manipulation utilities.
 *
 * `stripRanges` takes a string and a list of half-open intervals and removes
 * all characters covered by any interval. Intervals are sorted, merged, and
 * applied left-to-right so the operation is O(n log k) where n = text length
 * and k = number of ranges.
 */

export type TextRange = readonly [number, number];

/**
 * Sort and merge overlapping or adjacent half-open ranges in O(k log k).
 * Adjacency is not merged: `[0,5)` and `[5,10)` stay separate. Only strictly
 * overlapping ranges (`r[0] <= last[1]`) collapse into one.
 */
export function mergeRanges(ranges: ReadonlyArray<TextRange>): Array<[number, number]> {
    const sorted = ranges.map((r) => [r[0], r[1]] as [number, number]).sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const r of sorted) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) {
            last[1] = Math.max(last[1], r[1]);
        } else {
            merged.push([r[0], r[1]]);
        }
    }
    return merged;
}

/**
 * Remove all characters in `ranges` from `text`.
 * Ranges must be half-open [start, end); they're clamped to [0, text.length]
 * and filtered for empty before sort+merge.
 */
export function stripRanges(text: string, ranges: ReadonlyArray<TextRange>): string {
    if (ranges.length === 0) return text;

    const sorted = ranges
        .map(([a, b]) => [clamp(a, 0, text.length), clamp(b, 0, text.length)] as [number, number])
        .filter(([a, b]) => a < b);

    const merged = mergeRanges(sorted);
    if (merged.length === 0) return text;

    let out = "";
    let cursor = 0;
    for (const [a, b] of merged) {
        out += text.slice(cursor, a);
        cursor = b;
    }
    out += text.slice(cursor);
    return out;
}

function clamp(n: number, lo: number, hi: number): number {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}
