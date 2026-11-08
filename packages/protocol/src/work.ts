/**
 * `work.*` wire contract for tracking and controlling managed background work.
 *
 * A Work is one tracked unit of work: a background subagent launch, or one
 * fire of a scheduled job. Three axes are reported separately on purpose: what
 * the execution did (`status`), how much of the answer survived (`completeness`), and whether
 * the user was told (`delivery`). A failed notification never turns a
 * completed Work into a failed one.
 *
 * The vocabularies live here, not in the sidecar, so the daemon that writes
 * them and the desktop that groups by them read the same strings.
 */

import type { ParamsOf } from "./rpcContract/types.js";
import type {
    workCancelSchema,
    workDeleteSchema,
    workGetSchema,
    workListSchema,
    workRetryDeliverySchema,
} from "./schemas/work.js";

export const WORK_STATUSES = [
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export type WorkWaitingTool = "askUser" | "planExit" | "permission";

export interface WorkWaitingSummary {
    toolCallId: string;
    toolName: WorkWaitingTool;
    sessionId: string;
    description?: string;
    /** Present only for a live, process-local permission projection. */
    requestId?: string;
    instanceId?: string;
}

export const WORK_KINDS = ["subagent", "scheduled"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/**
 * `reason` of a scheduled Work whose prompt was queued behind a turn already
 * running in its session. That turn's reply answers both, so this Work has no
 * reply of its own; clients show it as merged rather than as a missing result.
 */
export const WORK_REASON_MERGED = "merged";

/** How much of the answer a terminal Work carries. */
export const WORK_COMPLETENESS = ["full", "partial", "unavailable"] as const;
export type WorkCompleteness = (typeof WORK_COMPLETENESS)[number];

export const WORK_DELIVERY_STATUSES = [
    /** Intent recorded; not yet confirmed by the platform. */
    "pending",
    /** Every frozen chunk was accepted by the platform. */
    "confirmed",
    /** Gave up after the retry budget. Manual retry only. */
    "retryExhausted",
    /** The platform refused for a reason retrying cannot fix. */
    "permanentFailure",
    /** Too old to be worth sending any more. Manual retry only. */
    "expired",
    /** The parent's own reply carries the news; there is no second copy. */
    "handedOff",
    "cancelled",
] as const;
export type WorkDeliveryStatus = (typeof WORK_DELIVERY_STATUSES)[number];

/**
 * Delivery states that mean the user was not told and nothing more will happen
 * on its own. The overview groups these under "needs attention".
 */
export const WORK_ATTENTION_DELIVERY_STATUSES: readonly WorkDeliveryStatus[] = [
    "retryExhausted",
    "expired",
    "permanentFailure",
];

/**
 * The subset a user can re-send from. A permanent failure is excluded on
 * purpose: the platform refused the target itself, and the frozen target cannot
 * change, so a manual send fails the same way. Retrying it would be a button
 * that never works.
 */
export const WORK_RETRYABLE_DELIVERY_STATUSES: readonly WorkDeliveryStatus[] = [
    "retryExhausted",
    "expired",
];

/**
 * Delivery state as the overview shows it. The peer and chat ids are left out:
 * they identify a person, and the overview only needs to say which channel.
 */
export interface WorkDeliverySummary {
    status: WorkDeliveryStatus;
    channelId: string;
    /** Counted failures since the last confirmed chunk. */
    attempts: number;
    /** Short machine code of the last failure, never platform text. */
    lastError?: string;
    /** Whether the message is the parent model's reply or the template. */
    source?: "parentReply" | "template";
    /** Epoch ms of the next automatic attempt, when one is scheduled. */
    nextAttemptAt?: number;
}

/** Availability of the overview's session target, independent of Work execution. */
export type WorkSessionState = "available" | "deleted" | "unavailable";

/** One Work as a list row. Never carries the answer text. */
export interface WorkSummary {
    workId: string;
    /** Bumped on every write; lets a reader tell two snapshots apart. */
    revision: number;
    kind: WorkKind;
    title: string;
    /** The subagent profile; absent for a scheduled fire. */
    agentType?: string;
    /** The job that fired, for a scheduled Work. */
    jobId?: string;
    status: WorkStatus;
    /** Current attempt identity; absent on older daemons. */
    attemptId?: string;
    /** Whether this attempt supports cancellation; absent on older daemons. */
    canCancel?: boolean;
    /** Why a failed, cancelled or interrupted Work ended. */
    reason?: string;
    createdAt: number;
    updatedAt: number;
    endedAt?: number;
    /**
     * Workspace and session the overview opens: the conversation that spawned a
     * subagent, or the session a scheduled fire ran in. Unlike the delivery
     * summary this is the full key — for an IM conversation that means
     * `im://channel/peer/chat`, because the key is the only way back to the
     * session. The delivery summary omits peer/chat because it names only which
     * channel was used, and the pane never opens a peer from it.
     */
    workspace?: string;
    sessionId: string;
    /** Absent on older daemons. Deleted targets keep their Work results. */
    sessionState?: WorkSessionState;
    waiting?: WorkWaitingSummary;
    /**
     * Deprecated alias of `sessionId`, kept so a 2.9 desktop can still open a
     * Work's session against a 2.10 daemon. New clients read `sessionId`.
     */
    parentSessionId: string;
    /** The subagent's own session; absent for a scheduled fire. */
    childSessionId?: string;
    completeness?: WorkCompleteness;
    /** First lines of the answer, for lists. */
    summary?: string;
    delivery?: WorkDeliverySummary;
    /** True when the user has something to do: a failed notice or an interrupted run. */
    needsAttention: boolean;
}

export type WorkListParams = ParamsOf<typeof workListSchema>;
export type WorkGetParams = ParamsOf<typeof workGetSchema>;
export type WorkRetryDeliveryParams = ParamsOf<typeof workRetryDeliverySchema>;
export type WorkCancelParams = ParamsOf<typeof workCancelSchema>;
export type WorkDeleteParams = ParamsOf<typeof workDeleteSchema>;

export type WorkCancelOutcome =
    | "accepted"
    | "not_found"
    | "not_running"
    | "attempt_mismatch"
    | "unsupported";

export interface WorkCancelResult {
    outcome: WorkCancelOutcome;
    /** False for a repeated request or when cancellation was not accepted. */
    newlyRequested: boolean;
}

export type WorkDeleteOutcome = "deleted" | "not_found" | "running";

export interface WorkDeleteResult {
    /** Only terminal records are deletable; waiting records must first be cancelled. */
    outcome: WorkDeleteOutcome;
}

export interface WorkListResult {
    /** The daemon that answered. A different value than last time means it was replaced. */
    instanceId: string;
    /** Every Work still running or needing attention, newest first. Always complete. */
    active: WorkSummary[];
    /** One page of finished Works, newest first. */
    terminal: WorkSummary[];
    /** Pass as `before` for the next page; absent on the last page. */
    nextCursor?: string;
}

export interface WorkGetResult {
    work: WorkSummary | null;
    /** The stored answer, capped at {@link WORK_RESULT_TEXT_LIMIT} characters. */
    resultText?: string;
    resultTruncated?: boolean;
}

export type WorkRetryDeliveryOutcome = "accepted" | "not_found" | "not_retryable";

export interface WorkRetryDeliveryResult {
    outcome: WorkRetryDeliveryOutcome;
}

/** Longest answer `work.get` returns inline. */
export const WORK_RESULT_TEXT_LIMIT = 64_000;

/** Default page size for finished Works in `work.list`; the schema caps it. */
export const WORK_LIST_DEFAULT_LIMIT = 50;
// Defined with the schema so the validator and the reader share one value
// without the schema importing this module (that would be a cycle).
export { WORK_LIST_MAX_LIMIT } from "./schemas/work.js";

/**
 * `work.changed` push params — empty, like the other invalidate pushes. The
 * frame says "the overview moved"; the client re-pulls `work.list`. Naming the
 * changed Work ids bought nothing: an id the client already shows may still
 * have changed state, and an id it does not know may be new, so every push
 * ends in the same fetch either way.
 */
export type WorkChangedParams = Record<string, never>;
