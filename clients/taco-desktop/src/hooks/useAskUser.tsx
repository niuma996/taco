/**
 * `answers` aligns with the protocol's `Record<string, string | string[]>` —
 * both single (string) and multi-select (string[]) are supported.
 */

import type { AskUserQuestion } from "@taco-ai/protocol";
import { createContext, type ReactNode, useContext } from "react";
import type { SidecarAction } from "./useSidecarStream";

export type AskUserAnswers = Record<string, string | string[]>;

/**
 * askUser injection payload — answers and the corresponding questions so the
 * injected user text is self-contained for the LLM.
 */
export interface AskUserPayload {
    answers: AskUserAnswers;
    questions: AskUserQuestion[];
    /** Tool that triggered this pending askUser; defaults to askUser. */
    toolName?: string;
}

export interface AskUserContextValue {
    dispatchAskUser: (action: SidecarAction) => void;
    /** Write answers + questions; consumed by useWorkspaces.sendPrompt for injection. */
    setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => void;
}

const AskUserContext = createContext<AskUserContextValue | null>(null);

export interface AskUserProviderProps {
    dispatchAskUser: (action: SidecarAction) => void;
    /** Write user-selected answers + questions; read by sendPrompt for injection. */
    setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => void;
    children: ReactNode;
}

export function AskUserProvider({
    dispatchAskUser,
    setAskUserAnswers,
    children,
}: AskUserProviderProps) {
    return (
        <AskUserContext.Provider
            value={{
                dispatchAskUser,
                setAskUserAnswers,
            }}
        >
            {children}
        </AskUserContext.Provider>
    );
}

export function useAskUser(): AskUserContextValue {
    const ctx = useContext(AskUserContext);
    if (!ctx) {
        throw new Error("useAskUser must be used inside <AskUserProvider>");
    }
    return ctx;
}
