import { type ImConversationEntry, makeImCwd } from "@taco-ai/protocol";
import { conversationActivityKey, getConversationActivity } from "./conversationActivity";
import type { WorkspaceState } from "./workspaceReducer";

export interface ConversationGroupItem {
    cwd: string;
    sessionId: string;
    label: string;
    updatedAt: string | number;
    pending: boolean;
    running: boolean;
    waiting: boolean;
    incomplete: boolean;
    error: boolean;
    unread: boolean;
}

export interface WorkspaceConversationGroup {
    key: string;
    kind: "workspace";
    cwd: string;
    label: string;
    items: ConversationGroupItem[];
}

export interface ChannelConversationItem extends ConversationGroupItem {
    channelId: string;
    peerId: string;
    chatId: string;
}

function workspaceLabel(cwd: string): string {
    const trimmed = cwd.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).pop() || cwd;
}

/**
 * `workspaces` insertion order is the persisted recent-use order from
 * desktop.json. ConversationSidebar freezes it for the rest of this run.
 * IM virtual workspaces use the flat list below.
 */
export function buildWorkspaceGroups(
    workspaces: Record<string, WorkspaceState>,
    unread: Readonly<Record<string, true>> = {},
): WorkspaceConversationGroup[] {
    return Object.values(workspaces)
        .filter((workspace) => !workspace.cwd.startsWith("im://"))
        .map<WorkspaceConversationGroup>((workspace) => ({
            key: `workspace:${workspace.cwd}`,
            kind: "workspace",
            cwd: workspace.cwd,
            label: workspaceLabel(workspace.cwd),
            items: workspace.sessions.map((session) => {
                const activity = getConversationActivity(workspace, session.id);
                return {
                    cwd: workspace.cwd,
                    sessionId: session.id,
                    label: session.name || session.id.slice(0, 8),
                    updatedAt: session.updatedAt ?? session.createdAt,
                    pending: activity.running,
                    ...activity,
                    unread: Boolean(
                        unread[
                            conversationActivityKey({
                                workspace: workspace.cwd,
                                sessionId: session.id,
                            })
                        ],
                    ),
                };
            }),
        }));
}

/**
 * One row per routed IM conversation. Channel and peer remain route metadata,
 * not visual directory levels. Newer sidecars supply session title/mtime;
 * older ones fall back to chatId and the router's last-used timestamp.
 */
export function buildChannelConversationItems(
    conversations: readonly ImConversationEntry[],
    workspaces: Record<string, WorkspaceState>,
    unread: Readonly<Record<string, true>> = {},
): ChannelConversationItem[] {
    const activityByConversation = new Map(
        conversations.map((conversation) => [
            makeImCwd(conversation.channelId, conversation.peerId, conversation.chatId),
            conversation.lastUsedAt,
        ]),
    );
    return conversations
        .map((conversation) => {
            const cwd = makeImCwd(conversation.channelId, conversation.peerId, conversation.chatId);
            const workspace = workspaces[cwd];
            const known = workspace?.sessions.find(
                (session) => session.id === conversation.sessionId,
            );
            const activity = getConversationActivity(workspace, conversation.sessionId);
            return {
                cwd,
                sessionId: conversation.sessionId,
                channelId: conversation.channelId,
                peerId: conversation.peerId,
                chatId: conversation.chatId,
                label: known?.name || conversation.name || conversation.chatId,
                updatedAt:
                    known?.updatedAt ??
                    known?.createdAt ??
                    conversation.updatedAt ??
                    conversation.lastUsedAt,
                pending: activity.running,
                ...activity,
                unread: Boolean(
                    unread[
                        conversationActivityKey({
                            workspace: cwd,
                            sessionId: conversation.sessionId,
                        })
                    ],
                ),
            };
        })
        .sort(
            (a, b) =>
                (activityByConversation.get(b.cwd) ?? 0) -
                    (activityByConversation.get(a.cwd) ?? 0) || a.cwd.localeCompare(b.cwd),
        );
}
