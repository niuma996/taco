/**
 * Work: one trackable unit of managed work — a background subagent launch, or
 * one fire of a scheduled `agent.invoke` job.
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

import type {
    WorkKind as WireWorkKind,
    WorkStatus as WireWorkStatus,
    WorkCompleteness,
    WorkDeliveryStatus,
    WorkSessionState,
    WorkWaitingSummary,
    WorkWaitingTool,
} from "@taco-ai/protocol";

export const WORK_SCHEMA_VERSION = 1;

/*
 * The vocabularies are the wire's: the overview groups by these strings, so a
 * second copy here would be a copy that drifts. See `@taco-ai/protocol` work.ts
 * for what each value means.
 */
export type WorkStatus = WireWorkStatus;
export type ResultCompleteness = WorkCompleteness;
export type DeliveryStatus = WorkDeliveryStatus;

export type WorkKind = WireWorkKind;
export type WorkWaiting = WorkWaitingSummary;
export type WaitingTool = WorkWaitingTool;

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
    /**
     * When a person last asked to send this again. Expiry counts from here
     * instead of from the end of the run, or a retry of an old notice would
     * be dropped as stale the moment it started.
     */
    readonly retriedAt?: number;
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
    /**
     * The workspace the parent session lives in, so the overview can open it.
     * Absent on records written before it was captured.
     */
    readonly workspace?: string;
    /**
     * The session the overview opens: the conversation that spawned a subagent,
     * or the session a scheduled fire ran in. The name predates scheduled Work;
     * it stays so records already on disk keep reading.
     */
    readonly parentSessionId: string;
    /** Persisted invalidation of the overview target; older records omit it. */
    readonly sessionState?: WorkSessionState;
    readonly waiting?: WorkWaiting;
    /** The subagent's own session. Absent for a scheduled fire. */
    readonly childSessionId?: string;
    /** The subagent profile. Absent for a scheduled fire. */
    readonly agentType?: string;
    /** The job that fired, for a scheduled Work. */
    readonly jobId?: string;
    readonly status: WorkStatus;
    /** The process that is driving this Work. A different id means it died. */
    readonly ownerInstanceId: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly endedAt?: number;
    /**
     * Where the notice goes, frozen at launch. Settling normally re-resolves the
     * route (a rebind may have moved it), but a Work whose driver died never
     * settles, and without this the user would never learn it stopped.
     */
    readonly deliveryTarget?: DeliveryTarget;
    /** The channel's message cap at launch, for the interruption notice. */
    readonly maxMessageLength?: number;
    readonly attempt: WorkAttempt;
    readonly result?: WorkResultRef;
    /** Why a failed/cancelled/interrupted Work ended, for display. */
    readonly reason?: string;
    readonly delivery?: WorkDelivery;
}

export function isTerminal(status: WorkStatus): boolean {
    return (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled" ||
        status === "interrupted"
    );
}

/** Delivery states that will never send anything more without a manual retry. */
export function isDeliveryFinal(status: DeliveryStatus): boolean {
    return status !== "pending";
}
