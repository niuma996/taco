/**
 * TUI visibility policy.
 *
 * Governs how tags appear in the TUI vs. what the model sees:
 *  - `hidden`: stripped entirely from TUI (model still receives them)
 *  - `ephemeral`: outer XML stripped, inner content shown (e.g. /plan directives)
 *  - `visible`: shown with outer tags
 *
 * Functions accept optional `hiddenNames` / `ephemeralNames` overrides so
 * tests can exercise the policy without polluting the production tag
 * registry with test-only fixtures. Production callers leave them undefined
 * and the function derives the set from the live registry.
 */

import { findBalancedTagsSkippingFences } from "../fenceAware.ts";
import { tagRegistry } from "../registry.ts";
import type { TagName } from "../types.ts";
import { mergeRanges, stripRanges } from "./textRanges.ts";

/** Tag names with `hidden` TUI visibility. */
export function getHiddenTagNames(): ReadonlyArray<TagName> {
    return Object.values(tagRegistry)
        .filter((s) => s.tuiVisibility === "hidden")
        .map((s) => s.name);
}

/** Tag names with `ephemeral` TUI visibility. */
export function getEphemeralTagNames(): ReadonlyArray<TagName> {
    return Object.values(tagRegistry)
        .filter((s) => s.tuiVisibility === "ephemeral")
        .map((s) => s.name);
}

/**
 * Whether `content` is empty after TUI visibility cleaning (all text blocks
 * empty and no image blocks). Used to decide if an entire message is hidden
 * from the UI — empty means don't push/render it (avoid empty bubbles).
 * Image blocks count as non-empty (user-attached images must show).
 */
export function isContentEmptyAfterVisibility(content: unknown): boolean {
    if (typeof content === "string") return content.trim().length === 0;
    if (!Array.isArray(content)) return true;
    return content.every((b) => {
        if (!b || typeof b !== "object") return false;
        const block = b as { type?: string; text?: unknown };
        if (block.type === "image") return false;
        return typeof block.text !== "string" || block.text.trim().length === 0;
    });
}

/** Strip all hidden tags from a string. */
export function stripHiddenTagsInMarkdown(
    text: string,
    hiddenNames: ReadonlyArray<TagName> = getHiddenTagNames(),
): string {
    const hidden = new Set(hiddenNames);
    if (hidden.size === 0) return text;
    const ranges: Array<[number, number]> = [];
    for (const name of hidden) {
        const matches = findBalancedTagsSkippingFences(text, name);
        for (const m of matches) ranges.push([...m.range] as [number, number]);
    }
    if (ranges.length === 0) return text;
    return stripRanges(text, ranges);
}

/**
 * Strip the outer XML wrapper from ephemeral tags, leaving their inner content.
 * The inner content becomes visible to the user in the TUI.
 */
export function stripEphemeralTagWrappers(
    text: string,
    ephemeralNames: ReadonlyArray<TagName> = getEphemeralTagNames(),
): string {
    const ephemeral = new Set(ephemeralNames);
    if (ephemeral.size === 0) return text;

    const ranges: Array<[number, number]> = [];
    const innerFragments: Array<{ start: number; text: string }> = [];

    for (const name of ephemeral) {
        const matches = findBalancedTagsSkippingFences(text, name);
        for (const m of matches) {
            ranges.push([...m.range] as [number, number]);
            innerFragments.push({ start: m.range[0], text: m.inner });
        }
    }

    if (ranges.length === 0) return text;

    const sorted = [...innerFragments].sort((a, b) => a.start - b.start);
    const merged = mergeRanges(ranges);

    let out = "";
    let cursor = 0;
    let innerIdx = 0;
    for (const [a, b] of merged) {
        out += text.slice(cursor, a);
        while (innerIdx < sorted.length) {
            const item = sorted[innerIdx];
            if (!item || item.start !== a) break;
            out += item.text;
            innerIdx++;
        }
        cursor = b;
    }
    out += text.slice(cursor);
    return out;
}
