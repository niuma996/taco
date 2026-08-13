/**
 * Pinned segment extraction. Two modes: read-only `extractPinnedSegments` and
 * `extractAndStripPinned` (compression pipeline uses the latter to avoid pin content
 * appearing twice). Dedup: first-seen wins per name. `pinOnce` segments carry an
 * `instanceId` recorded in `CompactionEntry.details.consumedPinOnceInstances`.
 */

import { createHash } from "node:crypto";

import { findBalancedTagsSkippingFences } from "./fenceAware.ts";
import { mapMessageText } from "./policy/messageContent.ts";
import { stripRanges } from "./policy/textRanges.ts";
import { tagRegistry } from "./registry.ts";
import type { PinnedSegment, TagName } from "./types.ts";

/** Names of tags with `pin` or `pinOnce` compression policy. */
function getPinNames(): TagName[] {
    return Object.values(tagRegistry)
        .filter((s) => {
            const kind = s.compression.kind;
            return kind === "pin" || kind === "pinOnce";
        })
        .map((s) => s.name);
}

/** Generate a stable instanceId for a pinned segment. */
function makeInstanceId(
    name: TagName,
    content: string,
    attrs: Readonly<Record<string, string>>,
): string {
    // skill_body: use the skill name from attrs as instanceId for per-skill dedup
    if (name === "skill_body") {
        const skillName = attrs.name;
        if (skillName) return `skill_body:${skillName}`;
    }
    // Otherwise: hash of name + content (deterministic, stable across re-extractions)
    const hash = createHash("sha256").update(`${name}:${content}`).digest("hex").slice(0, 16);
    return `${name}:${hash}`;
}

/**
 * Extract pinned segments from messages (read-only).
 * Only processes string content — block[] content is skipped.
 */
export function extractPinnedSegments(
    messages: ReadonlyArray<{ content: unknown }>,
): PinnedSegment[] {
    const pinNames = getPinNames();
    const seen = new Map<TagName, PinnedSegment>();
    for (const msg of messages) {
        if (typeof msg.content !== "string") continue;
        for (const name of pinNames) {
            if (seen.has(name)) continue;
            const matches = findBalancedTagsSkippingFences(msg.content, name);
            if (matches.length > 0) {
                const first = matches[0];
                if (first) {
                    const instanceId = makeInstanceId(name, first.inner, first.attrs);
                    seen.set(name, { name, content: first.inner, attrs: first.attrs, instanceId });
                }
            }
        }
    }
    return [...seen.values()];
}

/** Result of `extractAndStripPinned`. */
export interface ExtractAndStripResult<M> {
    /** Deduplicated pinned segments (first-seen wins), in discovery order. */
    pinned: PinnedSegment[];
    /** Messages with pin ranges stripped from their text content. */
    strippedMessages: M[];
}

/**
 * Extract pinned segments AND strip them from the original messages.
 * Used by the compression pipeline to keep pin content out of both the
 * (truncated) original messages AND the tail block.
 */
export function extractAndStripPinned<M extends { content: unknown }>(
    messages: ReadonlyArray<M>,
): ExtractAndStripResult<M> {
    const pinNames = getPinNames();
    const seen = new Map<TagName, PinnedSegment>();
    const strippedMessages = messages.map((msg) => {
        return mapMessageText(msg, (text) => {
            const ranges: Array<readonly [number, number]> = [];
            for (const name of pinNames) {
                const matches = findBalancedTagsSkippingFences(text, name);
                for (const m of matches) {
                    ranges.push(m.range);
                    if (!seen.has(name)) {
                        const instanceId = makeInstanceId(name, m.inner, m.attrs);
                        seen.set(name, { name, content: m.inner, attrs: m.attrs, instanceId });
                    }
                }
            }
            if (ranges.length === 0) return text;
            return stripRanges(text, ranges);
        });
    });
    return { pinned: [...seen.values()], strippedMessages };
}
