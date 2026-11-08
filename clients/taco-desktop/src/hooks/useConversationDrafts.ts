import {
    type Dispatch,
    type SetStateAction,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
} from "react";
import type { ModelSelection } from "../components/settings/ModelPicker";
import type { StagedAttachment } from "../lib/attachments";
import {
    type ConversationDraftState,
    ConversationDrafts,
    type ConversationTarget,
    type DraftSubmission,
} from "../lib/chat/conversationDrafts";

export type {
    ConversationTarget,
    DraftRecovery,
    DraftSubmission,
    DraftTarget,
} from "../lib/chat/conversationDrafts";

export interface UseConversationDraftsResult extends ConversationDraftState {
    setInput: Dispatch<SetStateAction<string>>;
    setAttachments: Dispatch<SetStateAction<StagedAttachment[]>>;
    setSelectedModel: Dispatch<SetStateAction<ModelSelection | null>>;
    beginSubmission(): DraftSubmission | null;
    completeSubmission(snapshot: DraftSubmission, success: boolean | "unknown"): void;
    restoreTexts(target: ConversationTarget, texts: readonly string[]): void;
    migrateDraft(workspace: string, draftId: string, sessionId: string): void;
    release(target: ConversationTarget): void;
    recoverSubmission(id: number): void;
}

const emptyState: ConversationDraftState = {
    input: "",
    attachments: [],
    revision: 0,
    selectedModel: null,
    recoveries: [],
};

/** Mount once above the composer; selection changes never release draft ownership. */
export function useConversationDrafts(
    target: ConversationTarget | null,
    initialModel: ModelSelection | null = null,
): UseConversationDraftsResult {
    const managerRef = useRef<ConversationDrafts | null>(null);
    if (!managerRef.current) managerRef.current = new ConversationDrafts();
    const manager = managerRef.current;
    const lifetime = useRef(0);
    useSyncExternalStore(manager.subscribe, manager.getVersion, manager.getVersion);
    const handle = useMemo(
        () => (target ? manager.bind(target, initialModel) : null),
        [manager, target, initialModel],
    );

    useEffect(() => {
        const generation = ++lifetime.current;
        return () => {
            // StrictMode replays effects synchronously. Defer final disposal so
            // that replay can keep the same manager and its live object URLs.
            queueMicrotask(() => {
                if (lifetime.current === generation) manager.dispose();
            });
        };
    }, [manager]);

    return {
        ...(handle?.getSnapshot() ?? emptyState),
        setInput: handle?.setInput ?? (() => {}),
        setAttachments: handle?.setAttachments ?? (() => {}),
        setSelectedModel: handle?.setSelectedModel ?? (() => {}),
        beginSubmission: handle?.beginSubmission ?? (() => null),
        completeSubmission: manager.completeSubmission,
        restoreTexts: manager.restoreTexts,
        migrateDraft: manager.migrateDraft,
        release: manager.release,
        recoverSubmission: handle?.recoverSubmission ?? (() => {}),
    };
}
