/**
 * `answers` aligns with the protocol's `Record<string, string | string[]>` —
 * both single (string) and multi-select (string[]) are supported.
 */

import type { AskUserQuestion } from "@taco-ai/protocol";
import { createContext, type ReactNode, useContext, useMemo } from "react";
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
    /** Submit the user's selection for one pending askUser / planExit card. */
    answerAskUser: (toolCallId: string, answers: AskUserAnswers) => void;
    /** Write answers + questions; consumed by useWorkspaces.sendPrompt for injection. */
    setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => void;
}

const AskUserContext = createContext<AskUserContextValue | null>(null);

export interface AskUserProviderProps {
    /** Workspace the rendered cards belong to; the provider stamps it onto every
     *  ASKUSER_ANSWERED so tool views never handle workspace paths. */
    cwd: string;
    dispatchAskUser: (action: SidecarAction) => void;
    /** Write user-selected answers + questions; read by sendPrompt for injection. */
    setAskUserAnswers: (toolCallId: string, payload: AskUserPayload) => void;
    children: ReactNode;
}

export function AskUserProvider({
    cwd,
    dispatchAskUser,
    setAskUserAnswers,
    children,
}: AskUserProviderProps) {
    const value = useMemo<AskUserContextValue>(
        () => ({
            answerAskUser: (toolCallId, answers) =>
                dispatchAskUser({ type: "ASKUSER_ANSWERED", cwd, toolCallId, answers }),
            setAskUserAnswers,
        }),
        [cwd, dispatchAskUser, setAskUserAnswers],
    );
    return <AskUserContext.Provider value={value}>{children}</AskUserContext.Provider>;
}

export function useAskUser(): AskUserContextValue {
    const ctx = useContext(AskUserContext);
    if (!ctx) {
        throw new Error("useAskUser must be used inside <AskUserProvider>");
    }
    return ctx;
}
