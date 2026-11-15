/**
 * SubagentContext — provides agentView (subagent tool card) with:
 *   - cwd: for `client.sessionHistory({ workspace: cwd, sessionId: subSessionId })`
 *   - loadSubagentHistory: reducer wrapper that writes back the history path
 *   - liveMessagesFor: reads the live UiMessage stream for a child session
 *
 * Only the minimal surface needed by agentView is exposed. Context value is
 * stabilized with useMemo to avoid re-rendering all messages on every provider
 * update.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { UiMessage } from "../lib/chat/chatUtils";
import type { SubagentEntry } from "../lib/chat/subagentList";

export interface SubagentContextValue {
    cwd: string;
    loadSubagentHistory: (subSessionId: string) => Promise<void>;
    /**
     * Reads the canonical child transcript, updated by both live events and history pulls.
     */
    liveMessagesFor: (subSessionId: string) => UiMessage[];
    /**
     * Reads the canonical child transcript once history has loaded.
     * Returns a stable empty array until history has loaded.
     */
    historyMessagesFor: (subSessionId: string) => UiMessage[];
    /**
     * Opens the given child session in the right-side panel. The inline card is
     * only an entry point now — the child stream renders in exactly one place.
     */
    openInPanel: (subSessionId: string) => void;
    agentTypeFor: (subSessionId: string) => string | undefined;
}

const SubagentContext = createContext<SubagentContextValue | null>(null);

export interface SubagentProviderProps {
    cwd: string;
    loadSubagentHistory: (subSessionId: string) => Promise<void>;
    /**
     * Provider reads the canonical child session. Transcript changes update the context.
     */
    liveMessagesFor: (subSessionId: string) => UiMessage[];
    historyMessagesFor: (subSessionId: string) => UiMessage[];
    openInPanel: (subSessionId: string) => void;
    children: ReactNode;
    entries?: readonly SubagentEntry[];
}

export function SubagentProvider({
    cwd,
    loadSubagentHistory,
    liveMessagesFor,
    historyMessagesFor,
    openInPanel,
    children,
    entries,
}: SubagentProviderProps) {
    // cwd is generally stable; other deps change ref every time workspaces state changes.
    const value = useMemo<SubagentContextValue>(
        () => ({
            cwd,
            loadSubagentHistory,
            liveMessagesFor,
            historyMessagesFor,
            openInPanel,
            agentTypeFor: (id: string) =>
                entries?.find((entry) => entry.subSessionId === id)?.agentType,
        }),
        [cwd, loadSubagentHistory, liveMessagesFor, historyMessagesFor, openInPanel, entries],
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
