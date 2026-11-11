import type { ChannelMediaRef } from "../channels/types.ts";
import type { WorkAttemptHandle, WorkOperationRef } from "./workOperationTypes.ts";
import type { DeliveryTarget } from "./workTypes.ts";

export type WorkQueueStatus =
    | "queued"
    | "admitting"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "cancelled";

export interface WorkQueueIntent {
    readonly sourceEventId: string;
    readonly kind: "scheduled" | "inbound";
    readonly title: string;
    readonly jobId?: string;
    readonly workspace: string;
    readonly sessionId: string;
    readonly lane: "main";
    readonly payload: {
        readonly text: string;
        readonly attachments?: readonly string[];
        readonly media?: readonly ChannelMediaRef[];
    };
    readonly createSession?: boolean;
    readonly sourceMemberIds?: readonly string[];
    readonly deliveryTarget?: DeliveryTarget;
    readonly deadlineAt?: number;
}

export interface WorkQueueEntry extends WorkQueueIntent {
    readonly schemaVersion: 1;
    readonly queueId: string;
    readonly sequence: number;
    readonly revision: number;
    readonly status: WorkQueueStatus;
    readonly enqueuedAt: number;
    readonly updatedAt: number;
    readonly deadlineAt: number;
    readonly driverEpoch?: string;
    readonly work?: WorkAttemptHandle;
    readonly operation?: WorkOperationRef;
    readonly operationAccepted?: boolean;
    readonly cancelRequestedAt?: number;
    readonly reason?: string;
}

export function isQueueTerminal(status: WorkQueueStatus): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

export type QueueCancelOutcome = "accepted" | "not_found" | "not_running" | "revision_mismatch";
