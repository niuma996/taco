/**
 * The seam between `AgentSpawner` and the Work layer.
 *
 * The spawner knows about subagents; Work knows about stores, channels and
 * delivery. Neither should import the other's internals, so the spawner is
 * handed this narrow interface and calls it at three moments: launch, settle,
 * and notice-run outcome. Every method must be safe to call and must not
 * throw into the spawner's settle chain — a Work failure cannot be allowed to
 * stop the parent from learning its child finished.
 */

import type { SessionId } from "@taco-ai/protocol";

export interface WorkLaunch {
    readonly workspace?: string;
    readonly parentSessionId: SessionId;
    readonly parentToolCallId: string;
    readonly childSessionId: SessionId;
    readonly agentType: string;
    readonly description?: string;
}

export interface WorkSettle {
    readonly outcome: "completed" | "error" | "aborted";
    readonly resultText: string;
    /** True when the run ended on its turn cap and returned what it had. */
    readonly partial: boolean;
    /** Where the answer was also written for the parent model, if the write worked. */
    readonly path?: string;
}

export interface BackgroundWorkHooks {
    /** Stable Work id for a launch; lets a later flush find the Work without a map. */
    workIdFor(parentSessionId: SessionId, parentToolCallId: string): string;
    /** Record the launch. Resolves to the Work id, or undefined if tracking is off. */
    onLaunch(launch: WorkLaunch): Promise<string | undefined>;
    /**
     * Commit the result and the delivery intent. Must resolve before the spawner
     * emits `subagent.settled`, so a consumer that sees the settle can rely on
     * the record already being on disk.
     */
    onSettle(workId: string, parentSessionId: SessionId, settle: WorkSettle): Promise<void>;
    /**
     * Whether a notice run's reply should be captured for this Work: only while
     * its delivery still waits for one. Once a message is frozen, a later run
     * (a late flush, say) is an ordinary turn and must reach the channel live.
     */
    wantsNoticeReply(workId: string): Promise<boolean>;
    /**
     * A run is about to answer the notice. Until the matching
     * `onNoticeRunRelease`, the channel must not forward that session's
     * assistant text — the reply is being captured as the message, and sending
     * it live as well would say it twice.
     */
    onNoticeRunStart(workId: string, parentSessionId: SessionId): void;
    /**
     * Ends the hold opened by `onNoticeRunStart`. Called exactly once per
     * start, whatever the outcome, and decides nothing about what is sent.
     */
    onNoticeRunRelease(workId: string, parentSessionId: SessionId): void;
    /** The run answered. `reply` is its final assistant text, if any. */
    onNoticeRunEnd(workId: string, reply: string | undefined): Promise<void>;
    /** The notice never produced a run: queued behind a busy parent, or no parent attached. */
    onNoticeNotRun(workId: string, reason: "queued" | "unreachable"): Promise<void>;
    /**
     * A resumed run is about to start for a child session. Reopens an
     * interrupted Work so its result can be recorded when the run ends.
     */
    onResumeStart(childSessionId: SessionId): Promise<void>;
    /**
     * A resumed run ended. Closes the reopened Work; `agentContinue` reports
     * through the conversation, so this queues no notice of its own.
     */
    onResumeSettle(childSessionId: SessionId, settle: WorkSettle): Promise<void>;
    /**
     * Whether this Work's outcome already reached the user another way: the
     * deliverer confirmed it, the parent's own reply carried it, or a resume
     * made the queued notice stale. A pending record from before a restart must
     * not prompt the parent again in those cases — that reports it twice.
     */
    noticeSettled(workId: string): Promise<boolean>;
}
