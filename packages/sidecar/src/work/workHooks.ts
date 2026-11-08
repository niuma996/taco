/**
 * The seams between the Work layer and the code that produces Work: the
 * subagent spawner and the job dispatcher.
 *
 * Producers know about subagents or jobs; Work knows about stores, channels
 * and delivery. Neither should import the other's internals, so each producer
 * is handed a narrow interface. Every method must be safe to call and must not
 * throw into the producer — a Work failure cannot be allowed to stop a parent
 * from learning its child finished, or fail the fire it describes.
 */

import type { SessionId } from "@taco-ai/protocol";
import type { WorkAttemptHandle } from "./workOperationTypes.ts";

export interface WorkLaunch {
    readonly workspace?: string;
    readonly parentSessionId: SessionId;
    readonly parentToolCallId: string;
    readonly childSessionId: SessionId;
    readonly agentType: string;
    readonly description?: string;
}

export interface WorkSettle {
    readonly attemptId?: string;
    readonly outcome: "completed" | "error" | "aborted";
    readonly resultText: string;
    /** True when the run ended on its turn cap and returned what it had. */
    readonly partial: boolean;
    /** Where the answer was also written for the parent model, if the write worked. */
    readonly path?: string;
    readonly waiting?: import("../runtime/session/waitingInteraction.ts").WaitingInteraction;
}

export interface WorkWaiting {
    readonly toolCallId: string;
    readonly toolName: "askUser" | "planExit";
    readonly sessionId: string;
    readonly description?: string;
}

export interface BackgroundWorkHooks {
    cancellationRequested?(
        workspace: string,
        sessionId: string,
        operationId: string,
    ): Promise<boolean>;
    run?<T>(workId: string, sessionId: string, run: (attemptId: string) => Promise<T>): Promise<T>;
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
    /** Park a background Work until its child session receives an answer. */
    onWaiting?(workId: string, waiting: WorkWaiting, attemptId?: string): Promise<void>;
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
    onResumeStart(
        childSessionId: SessionId,
        workspace?: string,
    ): Promise<WorkAttemptHandle | undefined>;
    /**
     * A resumed run ended. Closes the reopened Work; `agentContinue` reports
     * through the conversation, so this queues no notice of its own.
     */
    onResumeSettle(
        childSessionId: SessionId,
        settle: WorkSettle,
        handle?: WorkAttemptHandle,
    ): Promise<void>;
    /**
     * Whether this Work's outcome already reached the user another way: the
     * deliverer confirmed it, the parent's own reply carried it, or a resume
     * made the queued notice stale. A pending record from before a restart must
     * not prompt the parent again in those cases — that reports it twice.
     */
    noticeSettled(workId: string): Promise<boolean>;
}

export interface ScheduledFire {
    readonly jobId: string;
    /** Unique per fire, so two fires of one job are two Works. */
    readonly fireId: string;
    readonly title: string;
    readonly workspace: string;
    /** The session the fire's turn runs in. */
    readonly sessionId: string;
}

export type ScheduledFireSettle =
    | {
          readonly outcome: "waiting";
          readonly waiting: import("../runtime/session/waitingInteraction.ts").WaitingInteraction;
      }
    | { readonly outcome: "completed"; readonly replyText: string }
    /**
     * Queued behind a turn already running, which then answered it. The reply
     * belongs to that turn, so it is recorded but marked as shared.
     */
    | { readonly outcome: "merged"; readonly replyText?: string }
    /** Queued, then stopped with its run or cleared before it ran. */
    | { readonly outcome: "cancelled"; readonly reason: string }
    | { readonly outcome: "error"; readonly message: string };

export interface ScheduledWorkHooks {
    onFireQueued?(workId: string, entryId: string): Promise<void>;
    run?<T>(workId: string, sessionId: string, run: (attemptId: string) => Promise<T>): Promise<T>;
    /** Record the fire before its turn starts. Resolves to the Work id, or undefined. */
    onFire(fire: ScheduledFire): Promise<string | undefined>;
    /** The fire's turn ended. */
    onFireSettle(workId: string, settle: ScheduledFireSettle): Promise<void>;
}
