/**
 * SubagentContext — provides agentView (subagent tool card) with:
 *   - cwd: for `client.sessionHistory(cwd, subSessionId)`
 *   - loadSubagentHistory: reducer wrapper that writes back the history path
 *   - liveMessagesFor: reads the live UiMessage stream for a child session
 *
 * Only the minimal surface needed by agentView is exposed. Context value is
 * stabilized with useMemo to avoid re-rendering all messages on every provider
 * update.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { UiMessage } from "../lib/chat/chatUtils";

export interface SubagentContextValue {
    cwd: string;
    loadSubagentHistory: (subSessionId: string) => Promise<void>;
    /**
     * Reads live UiMessage stream for a child session — from the reducer's
     * `childMessagesBySubSessionId[subSessionId]`. Written continuously by
     * CHILD_MESSAGE_EVENT routed by useSidecarStream.
     */
    liveMessagesFor: (subSessionId: string) => UiMessage[];
    /**
     * Reads lazily-loaded history for a child session (reducer.childHistoryLoaded).
     * Filled after `loadSubagentHistory` is called; serves as the fallback to the
     * live stream when the user opens an agent card mid-session (no more push
     * events will arrive after detach).
     */
    historyMessagesFor: (subSessionId: string) => UiMessage[];
}

const SubagentContext = createContext<SubagentContextValue | null>(null);

export interface SubagentProviderProps {
    cwd: string;
    loadSubagentHistory: (subSessionId: string) => Promise<void>;
    /**
     * Provider reads liveMessagesFor from activeWs.childMessagesBySubSessionId.
     * Changing activeWs updates the value and re-renders children.
     */
    liveMessagesFor: (subSessionId: string) => UiMessage[];
    historyMessagesFor: (subSessionId: string) => UiMessage[];
    children: ReactNode;
}

export function SubagentProvider({
    cwd,
    loadSubagentHistory,
    liveMessagesFor,
    historyMessagesFor,
    children,
}: SubagentProviderProps) {
    // cwd is generally stable; other deps change ref every time workspaces state changes.
    const value = useMemo<SubagentContextValue>(
        () => ({ cwd, loadSubagentHistory, liveMessagesFor, historyMessagesFor }),
        [cwd, loadSubagentHistory, liveMessagesFor, historyMessagesFor],
    );
    return <SubagentContext.Provider value={value}>{children}</SubagentContext.Provider>;
}

export function useSubagent(): SubagentContextValue {
    const ctx = useContext(SubagentContext);
    if (!ctx) {
        throw new Error("useSubagent must be used inside <SubagentProvider>");
    }
    return ctx;
}
