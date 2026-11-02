/**
 * Work: one trackable unit of managed work — today, a background subagent
 * launch.
 *
 * A Work record is the process-level ledger entry that outlives the session
 * that started it. Three axes are kept apart on purpose:
 *
 *  - `status`        what the execution did,
 *  - `completeness`  how much of the answer survived,
 *  - `delivery`      whether the user was told.
 *
 * A failed notification never turns a completed Work into a failed one, and a
 * completed Work does not mean the business goal was verified — only that the
 * run closed normally and its result is on disk.
 */

export const WORK_SCHEMA_VERSION = 1;

export type WorkStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type WorkKind = "subagent";

/** How much of the answer a terminal Work carries. */
export type ResultCompleteness = "full" | "partial" | "unavailable";

export type DeliveryStatus =
    /** Intent recorded; not yet confirmed by the platform. */
    | "pending"
    /** Every frozen chunk was accepted by the platform. */
    | "confirmed"
    /** Gave up after the retry budget. Manual retry only. */
    | "retryExhausted"
    /** The platform refused for a reason retrying cannot fix. */
    | "permanentFailure"
    /** Too old to be worth sending any more. */
    | "expired"
    /**
     * The parent session was mid-turn, so the notice went into its follow-up
     * queue and the model's own reply carries it. There is no second copy.
     */
    | "handedOff"
    | "cancelled";

/** Where the user is told. Frozen when the Work settles. */
export interface DeliveryTarget {
    readonly channelId: string;
    readonly peerId: string;
    readonly chatId: string;
}

export interface WorkDelivery {
    readonly deliveryId: string;
    readonly target: DeliveryTarget;
    readonly status: DeliveryStatus;
    /**
     * Set while the parent model is still expected to write the notice. The
     * deliverer holds back until the deadline, then falls back to the template.
     */
    readonly awaitingParentReplyUntil?: number;
    /** Frozen message, split to the channel's cap. Absent until frozen. */
    readonly chunks?: readonly string[];
    /**
     * The template notice, built at settle time. Kept beside `chunks` so that
     * if the parent model never writes a reply, the deliverer can freeze this
     * one without needing the result text again.
     */
    readonly templateChunks?: readonly string[];
    readonly source?: "parentReply" | "template";
    /** The channel's per-message cap at settle time; later chunking reuses it. */
    readonly maxMessageLength: number;
    readonly confirmedChunks: number;
    readonly attempts: number;
    readonly nextAttemptAt?: number;
    readonly lastError?: string;
    readonly createdAt: number;
}

export interface WorkAttempt {
    readonly attemptId: string;
    readonly startedAt: number;
    readonly endedAt?: number;
}

export interface WorkResultRef {
    readonly resultId: string;
    readonly checksum: string;
    readonly completeness: ResultCompleteness;
    /** First lines of the answer, for lists. Never the whole text. */
    readonly summary: string;
    /** Where the answer was also written for the parent model to read. */
    readonly path?: string;
}

export interface WorkRecord {
    readonly schemaVersion: typeof WORK_SCHEMA_VERSION;
    readonly workId: string;
    /** Bumped on every write; lets a reader tell two snapshots apart. */
    readonly revision: number;
    readonly kind: WorkKind;
    readonly title: string;
    /** Dedup key: the same source event never creates a second Work. */
    readonly sourceEventId: string;
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly agentType: string;
    readonly status: WorkStatus;
    /** The process that is driving this Work. A different id means it died. */
    readonly ownerInstanceId: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly endedAt?: number;
    readonly attempt: WorkAttempt;
    readonly result?: WorkResultRef;
    /** Why a failed/cancelled/interrupted Work ended, for display. */
    readonly reason?: string;
    readonly delivery?: WorkDelivery;
}

export function isTerminal(status: WorkStatus): boolean {
    return status !== "running";
}

/** Delivery states that will never send anything more without a manual retry. */
export function isDeliveryFinal(status: DeliveryStatus): boolean {
    return status !== "pending";
}
