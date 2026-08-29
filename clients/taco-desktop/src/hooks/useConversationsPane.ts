import { type ImConversationEntry, makeImCwd } from "@taco-ai/protocol";
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./useAutoClearError";

export interface UseConversationsPaneResult {
    conversations: ImConversationEntry[] | null;
    loading: boolean;
    error: string | null;
    /**
     * Count of conversations with new traffic since the user last opened the
     * list, excluding the conversation currently being viewed (`activeCwd`).
     * Purely client-side — the server has no read/unread concept.
     */
    unreadCount: number;
    refreshConversations: () => Promise<void>;
    /** Called from the `channels.conversations_changed` push callback. */
    onConversationsChanged: () => void;
    /** Reset the unread counter — call when the user opens the conversations tab. */
    markConversationsSeen: () => void;
}

/**
 * Loads the IM conversation list and reacts to the
 * `channels.conversations_changed` push.
 *
 * The hook mirrors `useChannelsPane`'s gating pattern: only fetches when
 * `active` is true, auto-clears errors after 4s, never throws out of its
 * own callbacks. Split into its own hook (rather than merged into
 * `useChannelsPane`) because binding lifecycle and conversation enumeration
 * are independent concerns — they happen to share a pane, nothing more.
 */
export function useConversationsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseConversationsPaneResult {
    const [conversations, setConversations] = useState<ImConversationEntry[] | null>(null);
    const [loading, setLoading] = useState(false);
    const { error, fail: failWith, clearError } = useAutoClearError();
    // Snapshot of lastUsedAt per sessionId from the last time the user opened
    // the tab. State (not a ref): mutating it must trigger a re-render so the
    // badge clears the moment the tab opens.
    const [lastSeen, setLastSeen] = useState<Map<string, number>>(new Map());
    // Whether the snapshot has ever been seeded. The FIRST fetch is treated as
    // "already seen" — without this, opening the pane the first time would
    // count every conversation as unread even though nothing is new.
    const [seeded, setSeeded] = useState(false);

    const refreshConversations = useCallback(async (): Promise<void> => {
        setLoading(true);
        clearError();
        try {
            const next = await client.channelsListConversations({});
            setConversations(next.conversations);
            if (!seeded) {
                setSeeded(true);
                setLastSeen(new Map(next.conversations.map((c) => [c.sessionId, c.lastUsedAt])));
            }
        } catch (e) {
            failWith(e);
        } finally {
            setLoading(false);
        }
    }, [client, clearError, failWith, seeded]);

    useEffect(() => {
        if (!active || !activeCwd) return;
        void refreshConversations();
    }, [active, activeCwd, refreshConversations]);

    /**
     * Re-pulls and updates the snapshot. Called from the push handler.
     * Unlike refreshConversations, does not flip `loading` — the push is a
     * background notification, not a user-initiated action.
     */
    const onConversationsChanged = useCallback((): void => {
        void client
            .channelsListConversations({})
            .then((next) => {
                setConversations(next.conversations);
                if (!seeded) {
                    setSeeded(true);
                    setLastSeen(
                        new Map(next.conversations.map((c) => [c.sessionId, c.lastUsedAt])),
                    );
                }
            })
            .catch((e: unknown) => {
                failWith(e);
            });
    }, [client, failWith, seeded]);

    /**
     * Compute unread by diffing against the snapshot from the last time the
     * user opened the tab (or the initial fetch). Conversations whose
     * lastUsedAt advanced since then count as unread; the conversation the
     * user is currently reading does not.
     */
    const unreadCount = (() => {
        if (!conversations) return 0;
        let n = 0;
        for (const c of conversations) {
            if (activeCwd === makeImCwd(c.channelId, c.peerId, c.chatId)) continue;
            const prev = lastSeen.get(c.sessionId);
            if (prev === undefined || c.lastUsedAt > prev) n += 1;
        }
        return n;
    })();

    const markConversationsSeen = useCallback((): void => {
        if (!conversations) return;
        setLastSeen(new Map(conversations.map((c) => [c.sessionId, c.lastUsedAt])));
    }, [conversations]);

    return {
        conversations,
        loading,
        error,
        unreadCount,
        refreshConversations,
        onConversationsChanged,
        markConversationsSeen,
    };
}
