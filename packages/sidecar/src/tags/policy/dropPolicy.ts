/**
 * Drop policy — strip tags with `compression.kind === "drop"` from context
 * BEFORE compression begins. This is the most aggressive compression policy.
 *
 * Policy functions accept an optional `names` override so tests can exercise
 * the strip / range machinery without polluting the production tag registry
 * with test-only fixtures. Production callers leave `names` undefined and
 * the function derives the set from the live registry.
 */

import { findBalancedTagsSkippingFences } from "../fenceAware.ts";
import { tagRegistry } from "../registry.ts";
import type { CompressionPolicy, TagName } from "../types.ts";
import { mapMessageText } from "./messageContent.ts";
import { stripRanges } from "./textRanges.ts";

/** Collect all tag names with `drop` compression policy. */
function getDropTagNames(): TagName[] {
    const out: TagName[] = [];
    for (const spec of Object.values(tagRegistry)) {
        if ((spec.compression as CompressionPolicy).kind === "drop") {
            out.push(spec.name);
        }
    }
    return out;
}

/** Collect the half-open ranges of all `drop` tags in a string. */
export function collectDropRanges(
    text: string,
    names: ReadonlyArray<TagName> = getDropTagNames(),
): Array<[number, number]> {
    if (names.length === 0) return [];
    const ranges: Array<[number, number]> = [];
    for (const name of names) {
        const matches = findBalancedTagsSkippingFences(text, name);
        for (const m of matches) ranges.push([m.range[0], m.range[1]] as [number, number]);
    }
    return ranges;
}

/** Strip all `drop` tags from a string. */
export function stripDropTagsInText(
    text: string,
    names: ReadonlyArray<TagName> = getDropTagNames(),
): string {
    const ranges = collectDropRanges(text, names);
    if (ranges.length === 0) return text;
    return stripRanges(text, ranges);
}

/**
 * Strip all `drop` tags from every message. Messages without a string-or-block
 * `content` field pass through unchanged.
 *
 * The signature is intentionally `ReadonlyArray<M>` so callers can hand us
 * an `AgentMessage[]` (whose union may include custom variants without a
 * `content` field, e.g. `BashExecutionMessage`) without an unsafe cast.
 * Output preserves input length and order.
 */
export function stripDropTagsFromMessages<M>(
    messages: ReadonlyArray<M>,
    names: ReadonlyArray<TagName> = getDropTagNames(),
): M[] {
    return messages.map((m) => {
        const obj = m as unknown as { content?: unknown };
        if (typeof obj?.content !== "string" && !Array.isArray(obj?.content)) {
            return m;
        }
        return mapMessageText(obj as { content: unknown }, (txt) =>
            stripDropTagsInText(txt, names),
        ) as unknown as M;
    });
}
