/**
 * Fence-aware tag parser.
 *
 * Detects code fences (``` or ~~~) in a string and skips any tag matches
 * that fall inside them. This prevents tags inside code blocks from being
 * parsed as document-level tags.
 */

import { findBalancedTags } from "./parser.ts";
import type { BalancedTag } from "./types.ts";

function findLineStart(text: string, from: number): number {
    let start = from;
    while (start > 0 && text[start - 1] !== "\n") start--;
    return start;
}

function findLineEnd(text: string, from: number): number {
    const nl = text.indexOf("\n", from);
    return nl === -1 ? text.length : nl + 1;
}

function fenceMarker(lineText: string): { ch: string; run: number } | null {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(lineText);
    if (!m) return null;
    const group = m[1];
    if (!group) return null;
    return { ch: group[0], run: group.length };
}

function isPureClosingFence(lineText: string): boolean {
    return /^[ \t]{0,3}(`{3,}|~{3,})[ \t\r\n]*$/.test(lineText);
}

function lineText(text: string, lineStart: number, lineEndExclusive: number): string {
    const end =
        lineEndExclusive > 0 && text[lineEndExclusive - 1] === "\n"
            ? lineEndExclusive - 1
            : lineEndExclusive;
    return text.slice(lineStart, end);
}

/** Returns the start/end positions of every fenced code block in the text. */
export function detectFences(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let i = 0;
    while (i < text.length) {
        const lineEnd = findLineEnd(text, i);
        const lineStart = findLineStart(text, i);
        const open = fenceMarker(lineText(text, lineStart, lineEnd));
        if (open) {
            let j = lineEnd;
            let foundEnd: number | null = null;
            while (j < text.length) {
                const closeEnd = findLineEnd(text, j);
                const closeLineStart = findLineStart(text, j);
                const close = fenceMarker(lineText(text, closeLineStart, closeEnd));
                if (close && close.ch === open.ch && close.run >= open.run) {
                    if (isPureClosingFence(lineText(text, closeLineStart, closeEnd))) {
                        foundEnd = closeEnd;
                        break;
                    }
                }
                j = closeEnd;
            }
            if (foundEnd !== null) {
                out.push([i, foundEnd]);
                i = foundEnd;
            } else {
                i = lineEnd;
            }
        } else {
            i = lineEnd;
        }
    }
    return out;
}

function isInsideAnyFence(pos: number, fences: ReadonlyArray<[number, number]>): boolean {
    for (const [a, b] of fences) {
        if (pos >= a && pos < b) return true;
    }
    return false;
}

/** Like findBalancedTags but skips tags inside fenced code blocks. */
export function findBalancedTagsSkippingFences(text: string, tagName: string): BalancedTag[] {
    const fences = detectFences(text);
    const all = findBalancedTags(text, tagName);
    return all.filter((t) => !isInsideAnyFence(t.range[0], fences));
}
