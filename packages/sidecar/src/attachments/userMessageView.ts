/**
 * What a client is shown for a stored user message.
 *
 * The stored message carries the hidden `attachments` tag so the model knows
 * the files exist. A client must not receive that tag: it would put paths in
 * the user's own bubble, and the client matches its optimistic bubble to the
 * server echo by text, so the echo's text has to be the text the user typed.
 *
 * `viewUserContent` is the one place that rule lives. Live push, history
 * replay and snapshots all call it, so they cannot disagree.
 */

import type { MessageAttachment } from "@taco-ai/protocol";

import type { ImageContent, TextContent } from "../runtime/pi/types.ts";
import { applyTuiVisibilityToContent, isContentEmptyAfterVisibility } from "../tags/index.ts";
import { parseAttachmentsTags } from "./attachmentsTag.ts";

type Content = string | (TextContent | ImageContent)[];

export interface UserMessageView {
    /** Content with hidden tags removed — what the bubble renders. */
    content: Content;
    /** Attachments the message carried, parsed from the hidden tag. */
    attachments: MessageAttachment[];
    /**
     * True when there is nothing to render: no visible text, no image block and
     * no attachment. A message that is only attachments is not empty, even
     * though its text is blank once the tag is gone.
     */
    empty: boolean;
}

function rawText(content: Content): string {
    if (typeof content === "string") return content;
    return content
        .filter((b): b is TextContent => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}

/**
 * The tag is appended after the user's text ("hello\n\n<attachments>…"), so
 * stripping it leaves a trailing blank run. Trim it, or the echo's text would
 * never equal the trimmed text the client showed optimistically.
 */
function trimTrailing(content: Content): Content {
    if (typeof content === "string") return content.trimEnd();
    return content.map((b) => (b.type === "text" ? { ...b, text: b.text.trimEnd() } : b));
}

/**
 * For a vision model, an image attachment is also inlined as an image block
 * (see composePrompt), appended after any images the client sent itself. The
 * chip already shows that file, so the inlined copy is dropped from the view;
 * left in, it would render twice and the echo would no longer match the
 * optimistic bubble, which has no inline images.
 *
 * The tag says how many were inlined (`inlined="1"`), so exactly that many
 * trailing image blocks are dropped. A client-sent image is never mistaken
 * for one, whatever the model could see.
 */
function dropInlinedAttachmentImages(
    content: Content,
    attachments: readonly MessageAttachment[],
): Content {
    if (typeof content === "string") return content;
    const inlined = attachments.filter((a) => a.inlined).length;
    const imageIdx = content.flatMap((b, i) => (b.type === "image" ? [i] : []));
    if (inlined === 0 || imageIdx.length < inlined) return content;
    const drop = new Set(imageIdx.slice(imageIdx.length - inlined));
    return content.filter((_, i) => !drop.has(i));
}

/**
 * Split a stored user message into display content and its attachments.
 *
 * Attachments are read from the unstripped text, then the usual visibility
 * pass removes the tag along with every other hidden tag. Trimming only
 * happens when a tag was present, so a message without attachments is
 * returned exactly as the existing visibility pass shapes it.
 */
export function viewUserContent(content: Content): UserMessageView {
    const attachments = parseAttachmentsTags(rawText(content));
    const stripped = applyTuiVisibilityToContent(content);
    const visible =
        attachments.length > 0
            ? dropInlinedAttachmentImages(trimTrailing(stripped), attachments)
            : stripped;
    return {
        attachments,
        content: visible,
        empty: attachments.length === 0 && isContentEmptyAfterVisibility(visible),
    };
}
