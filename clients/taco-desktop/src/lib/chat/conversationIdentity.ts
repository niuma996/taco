import type { SessionTarget } from "@taco-ai/protocol";

export type { SessionTarget };

export interface DraftTarget {
    readonly workspace: string;
    readonly draftId: string;
}

export type ConversationTarget =
    | { readonly kind: "session"; readonly target: SessionTarget }
    | { readonly kind: "draft"; readonly target: DraftTarget };

/** Stable across navigation; drafts never share a session's cache or creation key. */
export function conversationKey(conversation: ConversationTarget): string {
    const id =
        conversation.kind === "session"
            ? conversation.target.sessionId
            : conversation.target.draftId;
    return JSON.stringify([conversation.kind, conversation.target.workspace, id]);
}
