import type { ImConversationEntry } from "@taco-ai/protocol";
import { type HiddenConversationBaseline, writeDesktopConfig } from "./desktopConfig";

/** Transcript metadata is deliberately excluded: only inbound route activity restores a row. */
export function hasNewConversationActivity(
    entry: ImConversationEntry,
    baseline: HiddenConversationBaseline,
): boolean {
    return entry.sessionId !== baseline.sessionId || entry.lastUsedAt > baseline.lastUsedAt;
}

export function persistHiddenConversation(
    cwd: string,
    baseline: HiddenConversationBaseline,
): Promise<void> {
    return writeDesktopConfig((current) => ({
        hiddenConversations: { ...current.hiddenConversations, [cwd]: baseline },
    }));
}

export function persistRestoredConversation(
    cwd: string,
    baseline: HiddenConversationBaseline,
): Promise<void> {
    return writeDesktopConfig((current) => {
        const hiddenConversations = { ...current.hiddenConversations };
        const saved = hiddenConversations[cwd];
        // A delayed restoration must not erase a subsequent hide of the same route.
        if (saved?.sessionId === baseline.sessionId && saved.lastUsedAt === baseline.lastUsedAt)
            delete hiddenConversations[cwd];
        return { hiddenConversations };
    });
}
