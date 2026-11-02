/**
 * `work.*` wire contract: the read-only overview of managed background work.
 *
 * A Work is one tracked unit of work, today a background subagent launch.
 * Three axes are reported separately on purpose: what the execution did
 * (`status`), how much of the answer survived (`completeness`), and whether
 * the user was told (`delivery`). A failed notification never turns a
 * completed Work into a failed one.
 *
 * The vocabularies live here, not in the sidecar, so the daemon that writes
 * them and the desktop that groups by them read the same strings.
 */

import type { ParamsOf } from "./rpcContract/types.js";
import type { workGetSchema, workListSchema, workRetryDeliverySchema } from "./schemas/work.js";

export const WORK_STATUSES = [
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

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

/** One Work as a list row. Never carries the answer text. */
export interface WorkSummary {
    workId: string;
    /** Bumped on every write; lets a reader tell two snapshots apart. */
    revision: number;
    kind: "subagent";
    title: string;
    agentType: string;
    status: WorkStatus;
    /** Why a failed, cancelled or interrupted Work ended. */
    reason?: string;
    createdAt: number;
    updatedAt: number;
    endedAt?: number;
    /**
     * Workspace and session that started it; the overview opens the session
     * from these. Unlike the delivery summary this is the full key — for an IM
     * conversation that means `im://channel/peer/chat`, because the key is the
     * only way back to the session. The delivery summary omits peer/chat
     * because it names only which channel was used, and the pane never opens a
     * peer from it.
     */
    workspace?: string;
    parentSessionId: string;
    childSessionId: string;
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
