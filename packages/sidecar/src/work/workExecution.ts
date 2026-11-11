import type { WorkCancelResult } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";
import { withManagedOperation } from "../runtime/harness/operationExecution.ts";
import { uuidv7 } from "../runtime/pi/values.ts";
import { resolveWaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import type { WorkController } from "./workController.ts";
import type { WorkOperationRef, WorkOperationRuntime } from "./workOperationTypes.ts";

export interface WorkExecutionAdmission {
    beforeAccept(): Promise<void>;
    afterAccept(): Promise<void>;
}

import { cancelWaiting, interrupt, UNREADABLE_WORK_STALE_MS } from "./workState.ts";
import type { WorkStore } from "./workStore.ts";
import { isTerminal } from "./workTypes.ts";

const log = createLogger("sidecar.work.execution");

function cancelled(): Error {
    return Object.assign(new Error("work attempt was cancelled or replaced"), {
        code: "aborted",
        terminalStatus: "aborted",
    });
}

/** Owns execution correlation; the Work controller never admits or drives harness operations. */
export class WorkExecution {
    constructor(
        private readonly store: WorkStore,
        private readonly controller: WorkController,
        private readonly runtime: WorkOperationRuntime | undefined,
        private readonly now: () => number,
        private readonly changed: (id: string) => void,
        private readonly instanceId: string,
    ) {}

    async run<T>(
        workId: string,
        sessionId: string,
        run: (attemptId: string) => Promise<T>,
        admission?: WorkExecutionAdmission,
    ): Promise<T> {
        const snapshot = await this.store.get(workId);
        if (snapshot?.status !== "running") throw cancelled();
        const attemptId = snapshot.attempt.attemptId;
        if (!snapshot.workspace) return run(attemptId);
        const ref: WorkOperationRef = snapshot.attempt.operation ?? {
            workspace: snapshot.workspace,
            sessionId,
            lane: "main",
            operationId: uuidv7(),
        };
        const bound = await this.store.mutate(workId, (current) =>
            current.status === "running" && current.attempt.attemptId === attemptId
                ? {
                      ...current,
                      ownerInstanceId: this.instanceId,
                      ...(current.delivery?.status === "pending"
                          ? { delivery: { ...current.delivery, status: "cancelled" as const } }
                          : {}),
                      attempt: { ...current.attempt, operation: ref },
                  }
                : undefined,
        );
        if (!bound?.changed) throw cancelled();
        this.changed(workId);
        return withManagedOperation(
            {
                ...ref,
                beforeAccept: async (operationId) => {
                    await admission?.beforeAccept();
                    const saved = await this.store.mutate(workId, (current) =>
                        current.status === "running" &&
                        current.attempt.attemptId === attemptId &&
                        current.attempt.cancelRequestedAt === undefined
                            ? {
                                  ...current,
                                  attempt: {
                                      ...current.attempt,
                                      operation: { ...ref, operationId },
                                  },
                              }
                            : undefined,
                    );
                    if (!saved?.changed) throw cancelled();
                },
                afterAccept: async (operationId) => {
                    try {
                        const saved = await this.store.mutate(workId, (current) =>
                            current.status === "running" && current.attempt.attemptId === attemptId
                                ? {
                                      ...current,
                                      attempt: { ...current.attempt, operationAccepted: true },
                                  }
                                : undefined,
                        );
                        if (
                            !saved?.changed ||
                            saved.record.attempt.cancelRequestedAt !== undefined
                        ) {
                            await this.runtime?.abort({ ...ref, operationId });
                        }
                        await admission?.afterAccept();
                    } catch (error) {
                        if (!admission) throw error;
                        throw Object.assign(new Error("accepted Work operation needs recovery"), {
                            code: "queue_recovery_required",
                            cause: error,
                        });
                    }
                },
            },
            () => run(attemptId),
        );
    }

    async cancel(workId: string, attemptId: string): Promise<WorkCancelResult> {
        const verdict: { outcome: WorkCancelResult["outcome"] } = { outcome: "not_found" };
        let newlyRequested = false;
        const changed = await this.store.mutate(workId, (current) => {
            if (current.attempt.attemptId !== attemptId) {
                verdict.outcome = "attempt_mismatch";
                return undefined;
            }
            if (isTerminal(current.status)) {
                verdict.outcome = "not_running";
                return undefined;
            }
            if (current.status !== "waiting" && (!current.attempt.operation || !this.runtime)) {
                verdict.outcome = "unsupported";
                return undefined;
            }
            verdict.outcome = "accepted";
            if (current.attempt.cancelRequestedAt !== undefined) return undefined;
            newlyRequested = true;
            const now = this.now();
            const next = {
                ...current,
                attempt: { ...current.attempt, cancelRequestedAt: now },
                updatedAt: now,
            };
            return current.status === "waiting" ? cancelWaiting(current, now) : next;
        });
        if (changed?.changed) this.changed(workId);
        const ref = changed?.record.attempt.operation;
        if (
            verdict.outcome === "accepted" &&
            ref &&
            changed?.record.status === "running" &&
            (changed.record.attempt.operationAccepted ||
                changed.record.ownerInstanceId !== this.instanceId)
        ) {
            const result = await this.runtime?.abort(ref);
            if (result?.outcome === "mismatch")
                return { outcome: "not_running", newlyRequested: false };
        }
        return { outcome: verdict.outcome, newlyRequested };
    }

    /** Read stored outcomes only. Attach-time recovery remains the sole operation driver. */
    async recover(): Promise<Set<string>> {
        const deferred = new Set<string>();
        if (!this.runtime) return deferred;
        for (const snapshot of await this.store.list()) {
            if (
                snapshot.status !== "running" ||
                snapshot.attempt.queueId !== undefined ||
                !snapshot.attempt.operation ||
                snapshot.ownerInstanceId === this.instanceId
            )
                continue;
            const ref = snapshot.attempt.operation;
            const cancelRequested = snapshot.attempt.cancelRequestedAt !== undefined;
            const observed = await this.runtime.inspect(ref).catch((error) => {
                log.warn("could not inspect the operation of a Work left by another process", {
                    workId: snapshot.workId,
                    error: String(error),
                });
                return { kind: "unknown" as const };
            });
            if (observed.kind === "open" || observed.kind === "unknown") {
                if (
                    observed.kind === "unknown" &&
                    this.now() - snapshot.attempt.startedAt >= UNREADABLE_WORK_STALE_MS
                ) {
                    // Unreadable forever is indistinguishable from gone: settle rather than
                    // leave a Work that no maintenance pass will ever interrupt.
                    await this.controller.settle({
                        workId: snapshot.workId,
                        attemptId: snapshot.attempt.attemptId,
                        outcome: cancelRequested ? "aborted" : "error",
                        resultText: "",
                        reason: cancelRequested
                            ? "cancelled by the user"
                            : "the process that ran this Work stopped and its session could not be read",
                        parentWillReply: false,
                        deliver: snapshot.kind !== "scheduled",
                    });
                    continue;
                }
                if (observed.kind === "open" && cancelRequested) await this.runtime.abort(ref);
                deferred.add(snapshot.workId);
                continue;
            }
            if (observed.kind !== "settled") continue;
            const waiting =
                observed.outcome === "completed"
                    ? resolveWaitingInteraction(observed.message, ref.sessionId)
                    : undefined;
            if (waiting)
                await this.controller.waitForInput(
                    snapshot.workId,
                    waiting,
                    snapshot.attempt.attemptId,
                );
            else
                await this.controller.settle({
                    workId: snapshot.workId,
                    attemptId: snapshot.attempt.attemptId,
                    outcome: observed.outcome,
                    resultText:
                        observed.message?.role === "assistant"
                            ? observed.message.content
                                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                                  .join("\n")
                            : "",
                    reason: observed.reason,
                    parentWillReply: false,
                    deliver: snapshot.kind !== "scheduled",
                });
        }
        return deferred;
    }

    async sessionSkipped(workspace: string, sessionId: string): Promise<void> {
        for (const work of await this.store.list()) {
            if (
                work.workspace !== workspace ||
                (work.childSessionId ?? work.parentSessionId) !== sessionId
            )
                continue;
            const result = await this.store.mutate(work.workId, (current) => {
                if (
                    current.attempt.attemptId !== work.attempt.attemptId ||
                    isTerminal(current.status)
                )
                    return undefined;
                const now = this.now();
                return interrupt(current, {
                    now,
                    reason: "session deletion skipped an execution that did not stop",
                });
            });
            if (result?.changed) this.changed(work.workId);
        }
    }
}
