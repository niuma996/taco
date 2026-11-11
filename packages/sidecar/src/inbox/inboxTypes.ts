import { createHash } from "node:crypto";
import type { SessionTarget } from "@taco-ai/protocol";
import type { ChannelMediaRef } from "../channels/types.ts";

export const INBOX_SCHEMA_VERSION = 1 as const;
export type InboxReceiptStatus =
    | "preparing"
    | "ready"
    | "batched"
    | "processing"
    | "completed"
    | "failed";

export interface InboxPreparation {
    readonly format: string;
    readonly data: unknown;
}

export interface InboxMessage {
    readonly bindingId: string;
    readonly channelId: string;
    readonly peerId: string;
    readonly chatId: string;
    readonly platformMessageId: string;
    readonly platformTimestamp?: number;
    readonly workspace: string;
    readonly text: string;
    readonly media?: readonly ChannelMediaRef[];
    readonly receivedAt: number;
    readonly preparation?: InboxPreparation;
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
    readonly platformTimestamp?: number;
    readonly workspace: string;
    readonly payload: Pick<InboxMessage, "text" | "media">;
    readonly status: InboxReceiptStatus;
    readonly revision: number;
    readonly receivedAt: number;
    readonly updatedAt: number;
    readonly attempts: number;
    readonly lastError?: string;
    readonly batchId?: string;
    readonly preparation?: InboxPreparation;
}

export interface InboxBatch {
    readonly schemaVersion: typeof INBOX_SCHEMA_VERSION;
    readonly batchId: string;
    readonly workspace: string;
    readonly memberReceiptIds: readonly string[];
    readonly createdAt: number;
    readonly frozenAt: number;
    readonly state?: "frozen" | "dispatching" | "submitted" | "failed";
    readonly target?: SessionTarget;
    readonly updatedAt?: number;
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

export const INBOX_FALLBACK_WINDOW_MS = 30_000;

/** A platform timestamp distinguishes intentional repeated text; without it matching is bounded. */
export function inboxDeliveryIds(message: InboxMessage): string[] {
    if (message.platformMessageId) return [message.platformMessageId];
    const media = message.media?.map((item) => [item.kind, item.name, item.source]);
    const fingerprint = createHash("sha256")
        .update(JSON.stringify([message.text.replace(/\r\n/g, "\n").trim(), media]))
        .digest("hex");
    if (message.platformTimestamp !== undefined)
        return [`fallback-time-${message.platformTimestamp}-${fingerprint}`];
    const window = Math.floor(message.receivedAt / INBOX_FALLBACK_WINDOW_MS);
    return [window, window - 1].map((at) => `fallback-window-${at}-${fingerprint}`);
}
