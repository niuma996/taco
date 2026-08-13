import type { ImageInput } from "@taco-ai/protocol";
import { type Dispatch, type SetStateAction, useState } from "react";

/** UI-only state for the chat input area + the modals it drives.
 *
 *  Groups eight sibling `useState`s that share a single call-site
 *  (chat input + Confirm/Rename/FilesDrawer modals + LlmDumpPanel
 *  toggle + session-id copy hint) so App.tsx doesn't re-accrete one
 *  every time someone adds a chip. Setters keep the standard
 *  `Dispatch<SetStateAction<T>>` shape — needed by the auto-clear
 *  updater on `copiedSessionId`.
 */
export interface UseChatInputStateResult {
    /** Session row id that just had its id copied; auto-clears. */
    copiedSessionId: string | null;
    setCopiedSessionId: Dispatch<SetStateAction<string | null>>;
    /** Chat textarea content. */
    input: string;
    setInput: Dispatch<SetStateAction<string>>;
    /** Pending image attachments for the next sendPrompt. */
    attachments: ImageInput[];
    setAttachments: Dispatch<SetStateAction<ImageInput[]>>;
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
    /** LlmDumpPanel visibility. */
    llmDumpOpen: boolean;
    setLlmDumpOpen: Dispatch<SetStateAction<boolean>>;
}

export function useChatInputState(): UseChatInputStateResult {
    const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
    const [input, setInput] = useState("");
    const [attachments, setAttachments] = useState<ImageInput[]>([]);
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
    const [llmDumpOpen, setLlmDumpOpen] = useState(false);

    return {
        copiedSessionId,
        setCopiedSessionId,
        input,
        setInput,
        attachments,
        setAttachments,
        confirmNewSession,
        setConfirmNewSession,
        pendingNewSessionCwd,
        setPendingNewSessionCwd,
        pendingDeleteSession,
        setPendingDeleteSession,
        pendingRenameSession,
        setPendingRenameSession,
        llmDumpOpen,
        setLlmDumpOpen,
    };
}
