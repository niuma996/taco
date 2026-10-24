/**
 * useStableUserMessageGuide — the guide's entries with a stable identity.
 *
 * The chat re-renders on every streaming token, and the guide indexes the
 * session's user messages. A new entries array on every token would make a
 * memoized rail re-render with it, so the entries are derived on every use
 * and the previous array is kept while its contents did not change: an
 * assistant token that leaves the user messages alone leaves the rail alone.
 *
 * The comparison covers everything a preview shows — id, absolute message
 * index, text and the images' type, data and mime type — so a changed or
 * shifted user message still produces a new array.
 *
 * A ref, not `useMemo`: React may drop a `useMemo` cache and recompute it,
 * which would break the very stability this hook exists to provide.
 */

import { useRef } from "react";

import type { UiMessage } from "../lib/chat/chatUtils";
import { buildUserMessageGuide, type UserMessageGuideEntry } from "../lib/chat/userMessageGuide";

/** Whether two entry lists carry the same user messages in the same order. */
function sameEntries(
    left: readonly UserMessageGuideEntry[],
    right: readonly UserMessageGuideEntry[],
): boolean {
    if (left.length !== right.length) return false;
    for (const [index, a] of left.entries()) {
        const b = right[index];
        if (!b) return false;
        if (a.id !== b.id) return false;
        if (a.messageIndex !== b.messageIndex) return false;
        if (a.text !== b.text) return false;
        if (a.images.length !== b.images.length) return false;
        for (const [imageIndex, image] of a.images.entries()) {
            const bImage = b.images[imageIndex];
            if (!bImage) return false;
            if (image.type !== bImage.type) return false;
            if (image.data !== bImage.data) return false;
            if (image.mimeType !== bImage.mimeType) return false;
        }
    }
    return true;
}

export function useStableUserMessageGuide(messages: readonly UiMessage[]): UserMessageGuideEntry[] {
    const entriesRef = useRef<UserMessageGuideEntry[]>([]);
    const entries = buildUserMessageGuide(messages);
    if (!sameEntries(entriesRef.current, entries)) {
        entriesRef.current = entries;
    }
    return entriesRef.current;
}
