import { type Dispatch, type SetStateAction, useState } from "react";

/** Modal and copy-feedback state; conversation drafts have a separate owner. */
export interface UseChatInputStateResult {
    /** Session row id that just had its id copied; auto-clears. */
    copiedSessionId: string | null;
    setCopiedSessionId: Dispatch<SetStateAction<string | null>>;
    /** "Discard unsent draft and create a new session" confirm modal. */
    confirmNewSession: boolean;
    setConfirmNewSession: Dispatch<SetStateAction<boolean>>;
    pendingNewSessionCwd: string | null;
    setPendingNewSessionCwd: Dispatch<SetStateAction<string | null>>;
    /** "Delete session" confirm modal payload. */
    pendingDeleteSession: { cwd: string; sessionId: string } | null;
    setPendingDeleteSession: Dispatch<SetStateAction<{ cwd: string; sessionId: string } | null>>;
    /** "Rename session" modal payload (carries the current name). */
    pendingRenameSession: {
        cwd: string;
        sessionId: string;
        currentName: string;
    } | null;
    setPendingRenameSession: Dispatch<
        SetStateAction<{
            cwd: string;
            sessionId: string;
            currentName: string;
        } | null>
    >;
}

export function useChatInputState(): UseChatInputStateResult {
    const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
    const [confirmNewSession, setConfirmNewSession] = useState(false);
    const [pendingNewSessionCwd, setPendingNewSessionCwd] = useState<string | null>(null);
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{
        cwd: string;
        sessionId: string;
    } | null>(null);
    const [pendingRenameSession, setPendingRenameSession] = useState<{
        cwd: string;
        sessionId: string;
        currentName: string;
    } | null>(null);

    return {
        copiedSessionId,
        setCopiedSessionId,
        confirmNewSession,
        setConfirmNewSession,
        pendingNewSessionCwd,
        setPendingNewSessionCwd,
        pendingDeleteSession,
        setPendingDeleteSession,
        pendingRenameSession,
        setPendingRenameSession,
    };
}
