/**
 * The `attachments` tag: how a message tells the model which files came with
 * it, and how the sidecar reads that back out to give clients chips to render.
 *
 *   <attachments>
 *   <file path="/abs/report.pdf" name="report.pdf" type="application/pdf" size="1234" kind="file"/>
 *   </attachments>
 *
 * The tag is the record. A client is never sent the raw tag (it is a hidden
 * tag); it gets the list this module parses out, so the text a client matches
 * its optimistic bubble against is the text the user typed.
 */

import type { MessageAttachment } from "@taco-ai/protocol";

import { escapeAttr, tagWrap } from "../tags/builder.ts";
import { findBalancedTagsSkippingFences } from "../tags/fenceAware.ts";

export const ATTACHMENTS_TAG = "attachments";

/** `&amp;` etc. back to characters; the inverse of `escapeAttr`. */
function unescapeAttr(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function fileElement(a: MessageAttachment): string {
    return (
        `<file path="${escapeAttr(a.path)}" name="${escapeAttr(a.name)}"` +
        ` type="${escapeAttr(a.mimeType)}" size="${a.size}" kind="${a.kind}"` +
        `${a.inlined ? ' inlined="1"' : ""}/>`
    );
}

/** Tag text for a message's attachments; empty string when there are none. */
export function buildAttachmentsTag(attachments: readonly MessageAttachment[]): string {
    if (attachments.length === 0) return "";
    return tagWrap(ATTACHMENTS_TAG, attachments.map(fileElement).join("\n"));
}

const FILE_ELEMENT = /<file\s+([^>]*?)\/>/g;
const ATTR = /([a-z]+)="([^"]*)"/g;

function parseFileAttrs(source: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const m of source.matchAll(ATTR)) {
        const key = m[1];
        const value = m[2];
        if (key !== undefined && value !== undefined) attrs[key] = unescapeAttr(value);
    }
    return attrs;
}

/**
 * Attachments named by every `attachments` tag in `text`. An element missing a
 * required attribute is skipped rather than guessed at.
 */
export function parseAttachmentsTags(text: string): MessageAttachment[] {
    const out: MessageAttachment[] = [];
    for (const tag of findBalancedTagsSkippingFences(text, ATTACHMENTS_TAG)) {
        for (const m of tag.inner.matchAll(FILE_ELEMENT)) {
            const attrs = parseFileAttrs(m[1] ?? "");
            const { path, name, type, size, kind, inlined } = attrs;
            if (path === undefined || name === undefined) continue;
            out.push({
                path,
                name,
                mimeType: type ?? "application/octet-stream",
                size: Number(size) || 0,
                kind: kind === "image" ? "image" : "file",
                ...(inlined === "1" ? { inlined: true } : {}),
            });
        }
    }
    return out;
}
