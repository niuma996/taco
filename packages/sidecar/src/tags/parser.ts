/**
 * XML-balanced tag parser.
 *
 * Scans a string for matching `<name>…</name>` open/close pairs using a linear,
 * non-recursive scan. When the same tag name re-opens before the previous one
 * closes, the outer frame is abandoned (innermost wins).
 *
 * The scanner uses `isBoundary()` to avoid false positives on partial matches
 * (e.g. `<requestFoo>` does not open a `<request>` tag).
 */

import type { BalancedTag } from "./types.ts";

export type { BalancedTag } from "./types.ts";

const ATTR_RE = /([a-zA-Z_][\w-]*)(?:\s*=\s*"([^"]*)")?/g;

function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    for (;;) {
        m = ATTR_RE.exec(s);
        if (!m) break;
        const key = m[1];
        if (key !== undefined) {
            out[key] = m[2] ?? "";
        }
    }
    return out;
}

function isBoundary(ch: string): boolean {
    return ch === "" || ch === ">" || ch === " " || ch === "\t" || ch === "\n" || ch === "/";
}

/**
 * Find all balanced `<tagName>…</tagName>` pairs in `text`.
 * Returns `BalancedTag[]` with `inner` content, parsed `attrs`, and half-open `range`.
 */
export function findBalancedTags(text: string, tagName: string): BalancedTag[] {
    const out: BalancedTag[] = [];
    const open = `<${tagName}`;
    const close = `</${tagName}>`;

    interface Frame {
        openAt: number;
        openEnd: number;
        attrs: Record<string, string>;
    }
    let frame: Frame | null = null;
    let cursor = 0;

    while (cursor < text.length) {
        const nextOpen = text.indexOf(open, cursor);
        const nextClose = text.indexOf(close, cursor);

        if (nextOpen === -1 && nextClose === -1) break;

        const openFirst = nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose);

        if (openFirst) {
            const nx = nextOpen + open.length;
            if (!isBoundary(text[nx] ?? "")) {
                cursor = nextOpen + 1;
                continue;
            }
            const openEnd = text.indexOf(">", nx);
            if (openEnd === -1) break;
            frame = { openAt: nextOpen, openEnd, attrs: parseAttrs(text.slice(nx, openEnd)) };
            cursor = openEnd + 1;
        } else {
            if (frame !== null) {
                const inner = text.slice(frame.openEnd + 1, nextClose);
                out.push({
                    inner,
                    attrs: frame.attrs,
                    range: [frame.openAt, nextClose + close.length],
                });
                frame = null;
            }
            cursor = nextClose + close.length;
        }
    }

    return out;
}
