import { asWorkspaceId, type ImConversationEntry, makeImCwd } from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { createLatestRequestGuard } from "../lib/latestRequest";
import { sidecarLogListenerReady } from "./useSidecarStream";

export interface UseConversationsPaneResult {
    conversations: ImConversationEntry[] | null;
    loading: boolean;
    error: string | null;
    /** New traffic since the list was last viewed, excluding the open chat. */
    unreadCount: number;
    refreshConversations: () => Promise<void>;
    onConversationsChanged: () => void;
    markConversationsSeen: () => void;
}

/** Process-wide conversation discovery, independent of the selected chat or configuration target. */
export function useConversationsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseConversationsPaneResult {
    const [conversations, setConversations] = useState<ImConversationEntry[] | null>(null);
    const [loading, setLoading] = useState(false);
    // A failed load must remain distinguishable from a successful empty result until retry.
    const [error, setError] = useState<string | null>(null);
    const [lastSeen, setLastSeen] = useState<Map<string, number>>(new Map());
    const seeded = useRef(false);
    const requestGuard = useRef(createLatestRequestGuard());
    const cwdRef = useRef(activeCwd);
    cwdRef.current = activeCwd;

    const refreshConversations = useCallback(async (): Promise<void> => {
        const cwd = cwdRef.current;
        if (!cwd) return;
        const isCurrent = requestGuard.current.begin();
        setLoading(true);
        setError(null);
        try {
            // Process RPCs require a fully initialized transport, including on pane entry and retry.
            await sidecarLogListenerReady;
            if (!isCurrent()) return;
            await client.start(asWorkspaceId(cwd));
            if (!isCurrent()) return;
            const next = await client.channelsListConversations({});
            if (!isCurrent()) return;
            setConversations(next.conversations);
            if (!seeded.current) {
                seeded.current = true;
                setLastSeen(new Map(next.conversations.map((c) => [c.sessionId, c.lastUsedAt])));
            }
        } catch (e) {
            if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (isCurrent()) setLoading(false);
        }
    }, [client]);

    useEffect(() => {
        const off = client.onConnectionReady(() => {
            requestGuard.current.invalidate();
            void refreshConversations();
        });
        return () => {
            off();
            requestGuard.current.invalidate();
        };
    }, [client, refreshConversations]);

    // Seed unread tracking even while hidden; cwd-only changes do not need another process query.
    const hasWorkspace = Boolean(activeCwd);
    useEffect(() => {
        if (hasWorkspace && (active || !seeded.current)) void refreshConversations();
    }, [active, hasWorkspace, refreshConversations]);

    const onConversationsChanged = useCallback((): void => {
        void refreshConversations();
    }, [refreshConversations]);

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
