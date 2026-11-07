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

export type SettleOutcome = "completed" | "error" | "aborted";

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
    return {
        ...record,
        status: "running",
        waiting: undefined,
        updatedAt: args.now,
        endedAt: undefined,
        reason: undefined,
        attempt: { attemptId: args.attemptId, startedAt: args.now },
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
        status: statusForOutcome(args.outcome),
        endedAt: args.now,
        updatedAt: args.now,
        attempt: { ...record.attempt, endedAt: args.now },
        ...(args.result ? { result: args.result } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
    };
}

/**
 * Mark a Work whose driver is gone. Only a running Work can be interrupted:
 * a finished one keeps the outcome it earned.
 */
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
        reason: args.reason,
    };
}
