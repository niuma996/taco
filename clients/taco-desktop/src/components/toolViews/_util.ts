/**
 * Tool-view internal utility.
 *
 * `truncate` — appends `…` (U+2026) when the string exceeds `max`,
 * otherwise returns it unchanged. Centralizing this keeps every view's
 * long-content strategy consistent (same ellipsis, same slice boundary);
 * new views just import rather than re-implementing.
 */

/** Truncate to `max` characters and append an ellipsis. */
export function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…` : s;
}
