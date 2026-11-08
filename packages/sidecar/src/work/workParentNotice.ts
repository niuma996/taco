/** Durable admission for one parent-model notice, independent of user delivery. */
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.ts";
import type { ParentNoticeDecision, ParentNoticeOutcome } from "./workHooks.ts";
import type { WorkStore } from "./workStore.ts";
import { isTerminal } from "./workTypes.ts";

const log = createLogger("sidecar.work.parentNotice");

export class WorkParentNotice {
    private readonly active = new Set<string>();
    constructor(
        private readonly store: WorkStore,
        private readonly instanceId: string,
        private readonly now: () => number = Date.now,
    ) {}

    async begin(workId: string, tracked = true): Promise<ParentNoticeDecision> {
        let decision: ParentNoticeDecision = { mode: "skip" };
        const result = await this.store.mutate(workId, (current) => {
            if (
                !isTerminal(current.status) ||
                current.delivery?.status === "cancelled" ||
                current.delivery?.status === "handedOff"
            )
                return undefined;
            if (
                current.parentNotice?.state === "claimed" &&
                current.parentNotice.ownerInstanceId === this.instanceId
            ) {
                if (this.active.has(current.parentNotice.claimId))
                    decision = { mode: "skip", retry: true };
                else log.warn("parent notification claim is ambiguous; not replaying", { workId });
                return undefined;
            }
            if (current.parentNotice) return undefined;
            const claimId = randomUUID();
            decision = { mode: current.delivery ? "capture" : "silent", claimId };
            const next = {
                ...current,
                parentNotice: {
                    attemptId: current.attempt.attemptId,
                    claimId,
                    ownerInstanceId: this.instanceId,
                    state: "claimed" as const,
                    claimedAt: this.now(),
                },
            };
            return next;
        });
        if (result) {
            if (result.changed && result.record.parentNotice)
                this.active.add(result.record.parentNotice.claimId);
            return decision;
        }
        if (await this.store.isDeleted(workId)) return { mode: "skip" };
        return tracked || (await this.store.hasSnapshot(workId))
            ? { mode: "skip", retry: true }
            : { mode: "legacy" };
    }

    /** A persisted claim is never recovered by a new owner: admission may already have run. */
    async end(workId: string, claimId: string, outcome: ParentNoticeOutcome): Promise<boolean> {
        try {
            const result = await this.store.mutate(workId, (current) => {
                const claim = current.parentNotice;
                if (
                    claim?.claimId !== claimId ||
                    claim.attemptId !== current.attempt.attemptId ||
                    claim.ownerInstanceId !== this.instanceId ||
                    claim.state !== "claimed"
                )
                    return undefined;
                const next = {
                    ...current,
                    parentNotice:
                        outcome.status === "not_run"
                            ? undefined
                            : { ...claim, state: "completed" as const, completedAt: this.now() },
                };
                return next;
            });
            return result?.changed ?? false;
        } finally {
            this.active.delete(claimId);
        }
    }
}
