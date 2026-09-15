/**
 * Crash recovery — drive the operations a previous process left in flight.
 *
 * Split out of `AttachedSession` because it is a self-contained sequence over
 * (lane, sessionId, open[]): it reads no other session state and reports its
 * result rather than mutating the session.
 */

import type { SessionId } from "@taco-ai/protocol";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { AgentLane, OpenOperation } from "../pi/types.ts";
import { NothingToResume } from "../pi/values.ts";
import { MAIN_BRANCH } from "./sessionBranch.ts";

const log = createLogger("sessionRecovery");

/**
 * What happened to one operation that a previous process left in flight.
 *
 * `status` is about the recovery attempt, not the operation's own result:
 *
 *   - `recovered` — resume drove it to a terminal state; the lane is usable.
 *     `outcome` carries pi's own status ("completed" / "aborted" / "suspended").
 *   - `already_settled` — it finished between `create()` reporting it and the
 *     resume call. Benign race, nothing was done.
 *   - `failed` — resume could not drive it. The lane may still be occupied, so
 *     this is the case that leaves a session needing manual intervention.
 *   - `skipped` — the entry belonged to another lane, which this session cannot
 *     resume (`lane.resume()` only recovers its own lane).
 */
export interface RecoveryOutcome {
    readonly operationId: string;
    readonly lane: string;
    readonly kind: OpenOperation["kind"];
    readonly status: "recovered" | "already_settled" | "failed" | "skipped";
    /** pi's terminal status when `status` is `recovered`. */
    readonly outcome?: string;
    /** Failure detail when `status` is `failed`. */
    readonly error?: string;
}

export interface ResumeOperationsArgs {
    readonly lane: AgentLane;
    readonly sessionId: SessionId;
    readonly open: ReadonlyArray<OpenOperation>;
}

/**
 * Drive operations that `AgentHarness.create()` reported as still open.
 *
 * Not optional: a restored operation occupies the lane's `state.operation`,
 * and `lane.prompt()` rejects with `LaneBusy` while that field is non-null —
 * ignoring `open[]` leaves the session unable to accept another message,
 * across restarts, with no way for the user to clear it. `lane.resume()`
 * re-enters the existing operation (same branch), and since no taco tool
 * opts into `replay: "safe"`, recovery never re-runs a side effect — an
 * unfinished call is reported as interrupted instead. Failures are
 * contained: the caller runs this detached from `create()`, so a session that
 * cannot be resumed is degraded, not fatal.
 */
export async function resumeOpenOperations(args: ResumeOperationsArgs): Promise<RecoveryOutcome[]> {
    const { lane, sessionId, open } = args;
    // A lane holds at most one operation (`state.operation` is a single
    // slot), and `lane.resume()` takes no id — it resumes whatever its own
    // lane is holding. So only the entry for this session's lane is
    // actionable; anything else would resume the wrong lane. taco attaches
    // exactly one lane per session, so in practice this selects 0 or 1.
    const mine = open.find((operation) => operation.lane === MAIN_BRANCH);
    // Record every entry, including the ones this session cannot act on —
    // a post-mortem needs to see that they were seen and deliberately left.
    const skipped: RecoveryOutcome[] = open
        .filter((operation) => operation !== mine)
        .map((operation) => ({
            operationId: operation.operationId,
            lane: operation.lane,
            kind: operation.kind,
            status: "skipped" as const,
        }));
    if (mine === undefined) {
        log.warn("interrupted operations belong to other lanes; not resuming", {
            sessionId,
            lanes: open.map((operation) => operation.lane),
        });
        return skipped;
    }

    // `aborting` means durable cancellation was requested before the crash.
    // Resuming still runs the operation to its terminal state, which is what
    // actually clears `state.operation` and frees the lane.
    const context = {
        sessionId,
        operationId: mine.operationId,
        kind: mine.kind,
        ...(mine.aborting === true ? { aborting: true } : {}),
    };
    const identity = { operationId: mine.operationId, lane: mine.lane, kind: mine.kind };
    const record = (outcome: RecoveryOutcome): RecoveryOutcome[] => [...skipped, outcome];
    try {
        const result = await lane.resume(harnessContext);
        if (!result.ok) {
            // NothingToResume is the benign race: the operation settled
            // between `create()` reporting it and this call.
            if (NothingToResume.is(result.error)) {
                log.debug("interrupted operation already settled", context);
                return record({ ...identity, status: "already_settled" });
            }
            log.warn("could not resume interrupted operation", {
                ...context,
                error: result.error.message,
            });
            return record({ ...identity, status: "failed", error: result.error.message });
        }
        const status = "status" in result.value ? result.value.status : "suspended";
        log.info("resumed interrupted operation", { ...context, status });
        return record({ ...identity, status: "recovered", outcome: status });
    } catch (error) {
        log.error("resuming an interrupted operation threw", context, error);
        return record({
            ...identity,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
