/**
 * Legal Work transitions. Pure functions over records: the store applies the
 * result, nothing here touches disk.
 *
 * Only transition commands are exposed. A caller cannot patch `status`
 * directly, which is what keeps "completed" from being written over a Work
 * that already ended some other way.
 */

import type {
    ResultCompleteness,
    WaitingTool,
    WorkRecord,
    WorkResultRef,
    WorkStatus,
} from "./workTypes.ts";
import { isTerminal } from "./workTypes.ts";

export const WAITING_WORK_STALE_MS = 7 * 24 * 60 * 60_000;

/** Legacy deadlines use the closed attempt, never a later snapshot update or restart time. */
export function withWaitingDeadline(record: WorkRecord): WorkRecord {
    if (record.status !== "waiting") return record;
    const waitingSince = record.waitingSince ?? record.attempt.endedAt ?? record.attempt.startedAt;
    const expiresAt = record.expiresAt ?? waitingSince + WAITING_WORK_STALE_MS;
    if (record.waitingSince === waitingSince && record.expiresAt === expiresAt) return record;
    return { ...record, waitingSince, expiresAt };
}

/** Also evaluates legacy records before their first migration has been persisted. */
export function isWaitingExpired(record: WorkRecord, now: number): boolean {
    if (record.status !== "waiting") return false;
    const deadline = withWaitingDeadline(record).expiresAt;
    return deadline !== undefined && now >= deadline;
}

export function expireWaiting(record: WorkRecord, now: number): WorkRecord | undefined {
    if (!isWaitingExpired(record, now)) return undefined;
    const timed = withWaitingDeadline(record);
    const stopped = interrupt(timed, {
        reason: "the user did not answer this interaction within seven days",
        now,
    });
    if (!stopped) return undefined;
    const { waiting, waitingSince, expiresAt } = timed;
    return {
        ...stopped,
        ...(waiting && waitingSince !== undefined && expiresAt !== undefined
            ? {
                  expiredInteraction: {
                      workspace: record.workspace,
                      sessionId: waiting.sessionId,
                      toolCallId: waiting.toolCallId,
                      toolName: waiting.toolName,
                      attemptId: record.attempt.attemptId,
                      waitingSince,
                      expiresAt,
                      expiredAt: now,
                  },
              }
            : {}),
    };
}

export type SettleOutcome = "completed" | "error" | "aborted";

export function cancelWaiting(record: WorkRecord, now: number): WorkRecord | undefined {
    if (record.status !== "waiting") return undefined;
    return {
        ...record,
        status: "cancelled",
        waiting: undefined,
        waitingSince: undefined,
        expiresAt: undefined,
        invalidatedInteraction: record.waiting
            ? { sessionId: record.waiting.sessionId, toolCallId: record.waiting.toolCallId }
            : undefined,
        endedAt: now,
        updatedAt: now,
        reason: "cancelled by the user",
        attempt: { ...record.attempt, endedAt: now, cancelRequestedAt: now },
    };
}

/** Retry the same persisted admission intent rather than creating another attempt. */
export function restoreInterruptedAttempt(record: WorkRecord): WorkRecord | undefined {
    if (
        record.status !== "interrupted" ||
        record.expiredInteraction ||
        record.attempt.cancelRequestedAt !== undefined
    )
        return undefined;
    return {
        ...record,
        status: "running",
        endedAt: undefined,
        reason: undefined,
        attempt: { ...record.attempt, endedAt: undefined },
    };
}

const OUTCOME_STATUS: Readonly<Record<SettleOutcome, WorkStatus>> = {
    completed: "completed",
    error: "failed",
    aborted: "cancelled",
};

export function statusForOutcome(outcome: SettleOutcome): WorkStatus {
    return OUTCOME_STATUS[outcome];
}

/**
 * A run that ended on its turn cap still has an answer, just an unfinished
 * one. An error with no text has nothing at all.
 */
export function completenessFor(args: {
    outcome: SettleOutcome;
    partial?: boolean;
    hasText: boolean;
}): ResultCompleteness {
    if (!args.hasText) return "unavailable";
    if (args.partial) return "partial";
    return args.outcome === "completed" ? "full" : "partial";
}

export function waitForInput(
    record: WorkRecord,
    args: {
        toolCallId: string;
        toolName: WaitingTool;
        sessionId: string;
        description?: string;
        now: number;
    },
): WorkRecord | undefined {
    if (record.status !== "running") return undefined;
    return {
        ...record,
        status: "waiting",
        waitingSince: args.now,
        expiresAt: args.now + WAITING_WORK_STALE_MS,
        waiting: {
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            sessionId: args.sessionId,
            ...(args.description ? { description: args.description } : {}),
        },
        updatedAt: args.now,
        attempt: { ...record.attempt, endedAt: args.now },
    };
}

export function resumeAttempt(
    record: WorkRecord,
    args: { attemptId: string; now: number },
): WorkRecord | undefined {
    if (record.status !== "waiting" && record.status !== "interrupted") return undefined;
    if (isWaitingExpired(record, args.now)) return undefined;
    return {
        ...record,
        status: "running",
        waiting: undefined,
        waitingSince: undefined,
        expiresAt: undefined,
        updatedAt: args.now,
        endedAt: undefined,
        reason: undefined,
        attempt: {
            attemptId: args.attemptId,
            startedAt: args.now,
            ...(record.waiting
                ? {
                      interaction: {
                          sessionId: record.waiting.sessionId,
                          toolCallId: record.waiting.toolCallId,
                      },
                  }
                : {}),
        },
    };
}

/**
 * Close a running Work. Returns `undefined` when the Work already ended: the
 * first terminal state wins, so a late duplicate settle cannot rewrite it.
 */
export function settle(
    record: WorkRecord,
    args: {
        outcome: SettleOutcome;
        result?: WorkResultRef;
        reason?: string;
        now: number;
    },
): WorkRecord | undefined {
    if (record.status !== "running") return undefined;
    return {
        ...record,
        waiting: undefined,
        waitingSince: undefined,
        expiresAt: undefined,
        status: statusForOutcome(args.outcome),
        endedAt: args.now,
        updatedAt: args.now,
        attempt: { ...record.attempt, endedAt: args.now },
        ...(args.result ? { result: args.result } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
    };
}

/** Interrupt active Work; a terminal Work keeps the outcome it already earned. */
export function interrupt(
    record: WorkRecord,
    args: { reason: string; now: number },
): WorkRecord | undefined {
    if (isTerminal(record.status)) return undefined;
    return {
        ...record,
        status: "interrupted",
        endedAt: args.now,
        updatedAt: args.now,
        attempt: { ...record.attempt, endedAt: args.now },
        waiting: undefined,
        waitingSince: undefined,
        expiresAt: undefined,
        reason: args.reason,
    };
}
