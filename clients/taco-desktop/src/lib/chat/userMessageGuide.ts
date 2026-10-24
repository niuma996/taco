/**
 * User message guide derivation — the left rail's entries are derived from the
 * session's message stream, never stored. The rail therefore lists every user
 * message in the session, including the ones the render window has not mounted
 * yet.
 *
 * Pure: no React, no DOM. The rail component owns the rendering and the
 * navigation callback; this module only decides which messages get an entry
 * and what that entry carries.
 */

import type { ImageInput } from "@taco-ai/protocol";

import type { UiMessage } from "./chatUtils";

/** One navigable user message. */
export interface UserMessageGuideEntry {
    /** Message id — stable across re-renders, used as the React key and the rail anchor. */
    id: string;
    /** Absolute index in the session's message array, not the render window's. */
    messageIndex: number;
    /** Raw prompt text. Empty for image-only messages. */
    text: string;
    /** Attached images. Empty when the prompt carries none. */
    images: readonly ImageInput[];
}

/**
 * Collect the user messages of a session into guide entries.
 *
 * `messageIndex` stays absolute so the caller can reveal a message that the
 * render window has not mounted (see `useMessageWindow().revealTo`).
 */
export function buildUserMessageGuide(messages: readonly UiMessage[]): UserMessageGuideEntry[] {
    const entries: UserMessageGuideEntry[] = [];
    for (const [messageIndex, message] of messages.entries()) {
        if (message.kind !== "user") continue;
        entries.push({
            id: message.id,
            messageIndex,
            text: message.text,
            images: message.images ?? [],
        });
    }
    return entries;
}
