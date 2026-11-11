import { createHash } from "node:crypto";
import type { ChannelMediaRef } from "../channels/types.ts";

export const INBOX_SCHEMA_VERSION = 1 as const;
export type InboxReceiptStatus = "ready" | "batched" | "processing" | "completed" | "failed";

export interface InboxMessage {
    readonly bindingId: string;
    readonly channelId: string;
    readonly peerId: string;
    readonly chatId: string;
    readonly platformMessageId: string;
    readonly workspace: string;
    readonly text: string;
    readonly media?: readonly ChannelMediaRef[];
    readonly receivedAt: number;
}

export interface InboxReceipt {
    readonly schemaVersion: typeof INBOX_SCHEMA_VERSION;
    readonly receiptId: string;
    readonly sourceKey: string;
    readonly bindingId: string;
    readonly channelId: string;
    readonly peerId: string;
    readonly chatId: string;
    readonly platformMessageId: string;
    readonly workspace: string;
    readonly payload: Pick<InboxMessage, "text" | "media">;
    readonly status: InboxReceiptStatus;
    readonly revision: number;
    readonly receivedAt: number;
    readonly updatedAt: number;
    readonly attempts: number;
    readonly lastError?: string;
    readonly batchId?: string;
}

export interface InboxBatch {
    readonly schemaVersion: typeof INBOX_SCHEMA_VERSION;
    readonly batchId: string;
    readonly workspace: string;
    readonly memberReceiptIds: readonly string[];
    readonly createdAt: number;
    readonly frozenAt: number;
}

export function inboxSourceKey(
    message: Pick<
        InboxMessage,
        "bindingId" | "channelId" | "peerId" | "chatId" | "platformMessageId"
    >,
): string {
    return JSON.stringify([
        message.bindingId,
        message.channelId,
        message.peerId,
        message.chatId,
        message.platformMessageId,
    ]);
}

export function inboxReceiptId(sourceKey: string): string {
    return `i-${createHash("sha256").update(sourceKey).digest("hex").slice(0, 32)}`;
}

export function inboxBatchId(workspace: string, receiptIds: readonly string[]): string {
    return `b-${createHash("sha256")
        .update(JSON.stringify([workspace, receiptIds]))
        .digest("hex")
        .slice(0, 32)}`;
}
