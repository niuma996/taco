import type { SessionTarget } from "@taco-ai/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    type ConversationWatermark,
    conversationActivityKey,
    createConversationWatermark,
    observeConversationMessages,
} from "../lib/chat/conversationActivity";
import { getSessionState } from "../lib/chat/sessionState";
import type { WorkspaceState } from "../lib/chat/workspaceReducer";

/** Read state belongs to the chat identity, independently of the bounded transcript cache.
 * Observe only canonical messages, after the existing stream processor has deduped/recovered them.
 * Start with a mount-time watermark: opening old history is not new activity. Metadata revisions,
 * selection and cache rehydration alone never create unread. State intentionally resets on app restart.
 */
export function useConversationActivity({
    workspaces,
    visibleTarget,
}: {
    workspaces: Record<string, WorkspaceState>;
    visibleTarget: SessionTarget | null;
}) {
    const [hasAttention, setHasAttention] = useState(
        () => document.visibilityState === "visible" && document.hasFocus(),
    );
    useEffect(() => {
        const updateAttention = () =>
            setHasAttention(document.visibilityState === "visible" && document.hasFocus());
        const blur = () => setHasAttention(false);
        window.addEventListener("focus", updateAttention);
        window.addEventListener("blur", blur);
        document.addEventListener("visibilitychange", updateAttention);
        updateAttention();
        return () => {
            window.removeEventListener("focus", updateAttention);
            window.removeEventListener("blur", blur);
            document.removeEventListener("visibilitychange", updateAttention);
        };
    }, []);
    const [startedAt] = useState(Date.now);
    const seen = useRef(new Map<string, ConversationWatermark>());
    const [unread, setUnread] = useState<Record<string, true>>({});
    const visibleKey =
        hasAttention && visibleTarget ? conversationActivityKey(visibleTarget) : null;

    useEffect(() => {
        const changed = new Set<string>();
        for (const ws of Object.values(workspaces)) {
            const ids = new Set([
                ...Object.keys(ws.sessionStatesById ?? {}),
                ...Object.keys(ws.sessionInteractions ?? {}),
                ...(ws.activeSession ? [ws.activeSession] : []),
            ]);
            for (const sid of ids) {
                const session = getSessionState(ws, sid);
                if (!session) continue;
                const key = conversationActivityKey({ workspace: ws.cwd, sessionId: sid });
                let watermark = seen.current.get(key);
                if (!watermark) {
                    watermark = createConversationWatermark();
                    seen.current.set(key, watermark);
                }
                if (
                    observeConversationMessages(
                        watermark,
                        session.messages,
                        session.historyLoaded,
                        startedAt,
                        session.execution === "running",
                    )
                )
                    changed.add(key);
            }
        }
        setUnread((previous) => {
            let next = previous;
            for (const key of changed) {
                if (key !== visibleKey && !next[key]) next = { ...next, [key]: true };
            }
            if (visibleKey && next[visibleKey]) {
                next = { ...next };
                delete next[visibleKey];
            }
            return next;
        });
    }, [workspaces, visibleKey, startedAt]);

    const release = useCallback((target: SessionTarget) => {
        const key = conversationActivityKey(target);
        seen.current.delete(key);
        setUnread((previous) => {
            if (!previous[key]) return previous;
            const next = { ...previous };
            delete next[key];
            return next;
        });
    }, []);
    return { unread, release };
}
