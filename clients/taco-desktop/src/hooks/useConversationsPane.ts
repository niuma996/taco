import { asWorkspaceId, type ImConversationEntry, makeImCwd } from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { conversationActivityKey } from "../lib/chat/conversationActivity";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { type HiddenConversationBaseline, readDesktopConfig } from "../lib/desktopConfig";
import {
    hasNewConversationActivity,
    persistHiddenConversation,
    persistRestoredConversation,
} from "../lib/hiddenConversations";
import { createLatestRequestGuard } from "../lib/latestRequest";
import { sidecarLogListenerReady } from "./useSidecarStream";

export interface UseConversationsPaneResult {
    conversations: ImConversationEntry[] | null;
    loading: boolean;
    error: string | null;
    /** New traffic since the list was last viewed, excluding the open chat. */
    unreadCount: number;
    /** Restored rows stay unread until the parent confirms the chat is actually visible/read. */
    restoredUnread: Record<string, true>;
    hideConversation: (cwd: string) => Promise<void>;
    markConversationRead: (cwd: string) => void;
    refreshConversations: () => Promise<void>;
    onConversationsChanged: () => void;
    markConversationsSeen: () => void;
}

function conversationCwd(entry: ImConversationEntry): string {
    return makeImCwd(entry.channelId, entry.peerId, entry.chatId);
}

function activityKey(entry: ImConversationEntry): string {
    return conversationActivityKey({
        workspace: conversationCwd(entry),
        sessionId: entry.sessionId,
    });
}

/** Process-wide conversation discovery, independent of the selected chat or configuration target. */
export function useConversationsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    transportCwd?: string,
): UseConversationsPaneResult {
    const [conversations, setConversations] = useState<ImConversationEntry[] | null>(null);
    const [loading, setLoading] = useState(false);
    // A failed load must remain distinguishable from a successful empty result until retry.
    const [error, setError] = useState<string | null>(null);
    const [lastSeen, setLastSeen] = useState<Map<string, number>>(new Map());
    const [restoredUnread, setRestoredUnread] = useState<Record<string, true>>({});
    const readActivity = useRef(new Map<string, number>());
    const seeded = useRef(false);
    const requestGuard = useRef(createLatestRequestGuard());
    const cwdRef = useRef(activeCwd || transportCwd);
    if (activeCwd || transportCwd) cwdRef.current = activeCwd || transportCwd;
    const entriesRef = useRef<ImConversationEntry[]>([]);
    const hiddenRef = useRef<Record<string, HiddenConversationBaseline>>({});
    const hiddenReady = useRef<Promise<void> | null>(null);

    const loadHidden = useCallback((): Promise<void> => {
        hiddenReady.current ??= readDesktopConfig({ strict: true })
            .then((config) => {
                hiddenRef.current = config.hiddenConversations ?? {};
            })
            .catch((error: unknown) => {
                hiddenReady.current = null;
                throw error;
            });
        return hiddenReady.current;
    }, []);

    const publishConversations = useCallback(async (): Promise<void> => {
        const restored: Record<string, true> = {};
        const saves: Promise<void>[] = [];
        const visible = entriesRef.current.filter((entry) => {
            const cwd = conversationCwd(entry);
            const baseline = hiddenRef.current[cwd];
            if (!baseline) return true;
            if (!hasNewConversationActivity(entry, baseline)) return false;
            delete hiddenRef.current[cwd];
            const key = activityKey(entry);
            const readAt = readActivity.current.get(key);
            if (readAt === undefined || entry.lastUsedAt > readAt) restored[key] = true;
            saves.push(persistRestoredConversation(cwd, baseline));
            return true;
        });
        // Publish before awaiting storage: newer lists and read acknowledgements must win.
        setConversations(visible);
        if (Object.keys(restored).length)
            setRestoredUnread((previous) => ({ ...previous, ...restored }));
        await Promise.all(saves);
    }, []);

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
            await loadHidden();
            if (!isCurrent()) return;
            const next = await client.channelsListConversations({});
            if (!isCurrent()) return;
            entriesRef.current = next.conversations;
            if (!seeded.current) {
                seeded.current = true;
                setLastSeen(new Map(next.conversations.map((c) => [c.sessionId, c.lastUsedAt])));
            }
            await publishConversations();
        } catch (e) {
            if (isCurrent()) setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (isCurrent()) setLoading(false);
        }
    }, [client, loadHidden, publishConversations]);

    const hideConversation = useCallback(
        async (cwd: string): Promise<void> => {
            const entry = entriesRef.current.find((entry) => conversationCwd(entry) === cwd);
            if (!entry) return;
            const baseline = { sessionId: entry.sessionId, lastUsedAt: entry.lastUsedAt };
            requestGuard.current.invalidate();
            setLoading(false);
            await persistHiddenConversation(cwd, baseline);
            hiddenRef.current[cwd] = baseline;
            setRestoredUnread((previous) => {
                const next = { ...previous };
                delete next[activityKey(entry)];
                return next;
            });
            // Reconcile against current metadata, never the snapshot from before the save.
            await publishConversations();
        },
        [publishConversations],
    );

    const markConversationRead = useCallback((cwd: string): void => {
        const entry = entriesRef.current.find((entry) => conversationCwd(entry) === cwd);
        if (!entry) return;
        const key = activityKey(entry);
        readActivity.current.set(key, entry.lastUsedAt);
        setRestoredUnread((previous) => {
            if (!previous[key]) return previous;
            const next = { ...previous };
            delete next[key];
            return next;
        });
        setLastSeen((previous) => new Map(previous).set(entry.sessionId, entry.lastUsedAt));
    }, []);

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

    // A transport-only default allows IM discovery with an explicitly empty local workspace list.
    const hasWorkspace = Boolean(activeCwd || transportCwd);
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
            if (restoredUnread[activityKey(c)]) {
                n += 1;
                continue;
            }
            if (activeCwd === conversationCwd(c)) continue;
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
        restoredUnread,
        hideConversation,
        markConversationRead,
        refreshConversations,
        onConversationsChanged,
        markConversationsSeen,
    };
}
