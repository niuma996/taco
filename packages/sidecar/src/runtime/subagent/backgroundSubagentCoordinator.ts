/** Coordinates background subagent settlement, durable notices, and retries. */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import { MAX_AGENT_TURNS } from "../../agents/loadAgents.ts";
import type { AgentDefinition, SubagentRuntime } from "../../agents/types.ts";
import { createLogger } from "../../lib/logger.ts";
import { writeTextAtomic } from "../../store/atomicFile.ts";
import { tagWrap } from "../../tags/builder.ts";
import type { BackgroundWorkHooks } from "../../work/workHooks.ts";
import { uuidv7 } from "../pi/values.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import type { AgentConversationRuntime } from "./agentConversationRuntime.ts";
import type { AgentEngine } from "./engines/types.ts";
import { deliverSubagentResult, deliverSubagentResultDetailed } from "./subagentDelivery.ts";
import {
    addPendingSubagentResult,
    clearPendingSubagentResult,
    readPendingSubagentResults,
} from "./subagentPending.ts";
import { subagentResultPath } from "./subagentResultsDir.ts";
import type { ResumeSubagentArgs } from "./subagentResume.ts";
import type { SubagentRunLifecycle } from "./subagentRunLifecycle.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";
import type { SubagentSessionArgs } from "./subagentTypes.ts";

const log = createLogger("sidecar.backgroundSubagent");

/**
 * Global cap on concurrently-running `background: true` spawns, across every
 * parent session in this workspace. Synchronous spawns are not counted — a
 * synchronous child is already bounded by its parent turn's lifetime, so it
 * cannot accumulate the way an unbounded set of background runs could.
 */
export const MAX_CONCURRENT_BACKGROUND_SUBAGENTS = 8;

/**
 * Wall-clock allowance per turn, used to derive a background run's time budget
 * from its turn budget.
 *
 * The two limits have to agree, or one of them silently governs: a run with a
 * 100-turn budget that is cut off after 10 minutes never reaches the turns it
 * was allowed, and the work it did is thrown away with the timeout. A turn
 * that legitimately needs more than this is rare — a model round trip plus a
 * tool call is seconds — and a turn stuck on a slow command is exactly what
 * the timeout exists to catch.
 */
const BACKGROUND_TURN_ALLOWANCE_MS = 30_000;

/** Shortest budget a background run gets, whatever its turn budget says. */
const MIN_BACKGROUND_TIMEOUT_MS = 10 * 60_000;

/**
 * Longest budget a background run gets, derived from the largest allowed turn
 * budget so that no permitted turn budget is cut short by the wall clock. A
 * run that reaches it is stuck, not slow.
 */
const MAX_BACKGROUND_TIMEOUT_MS = MAX_AGENT_TURNS * BACKGROUND_TURN_ALLOWANCE_MS;

/**
 * Turn budget assumed when a profile sets none. The pi runtime leaves such a
 * run unbounded in turns, so the wall clock is its only bound and this decides
 * how long that bound is.
 */
const ASSUMED_TURNS_WITHOUT_CAP = 100;

/**
 * The wall-clock budget for a `background: true` spawn whose profile sets no
 * `timeoutMinutes`.
 *
 * Derived from the turn budget so the turn cap is the limit the person who
 * wrote the profile actually chose, and the timeout only catches a run that
 * is stuck rather than one that is still working.
 */
export function backgroundTimeoutMs(maxTurns: number | undefined): number {
    const turns = maxTurns !== undefined && maxTurns > 0 ? maxTurns : ASSUMED_TURNS_WITHOUT_CAP;
    const derived = turns * BACKGROUND_TURN_ALLOWANCE_MS;
    return Math.min(MAX_BACKGROUND_TIMEOUT_MS, Math.max(MIN_BACKGROUND_TIMEOUT_MS, derived));
}

export interface BackgroundSubagentCoordinatorOptions {
    readonly sessionRegistry: SessionRegistry;
    readonly conversation: AgentConversationRuntime;
    readonly runLifecycle: SubagentRunLifecycle;
    readonly engines: Record<SubagentRuntime, AgentEngine>;
    readonly workHooks?: BackgroundWorkHooks;
    readonly sessionsRoot: string;
    readonly workspaceKey: WorkspaceId;
    readonly executeSubagentSession: (args: SubagentSessionArgs) => Promise<SubagentRunResult>;
    readonly runResume: (args: ResumeSubagentArgs) => Promise<SubagentRunResult>;
    readonly trackInFlight: <T>(
        parentSessionId: SessionId,
        parentToolCallId: string,
        run: () => Promise<T>,
    ) => Promise<T>;
    readonly hasChatRun: (runId: string) => boolean;
    readonly settleChatRun: (runId: string, outcome: "completed" | "error" | "aborted") => void;
    readonly emit: (event: string, payload: unknown) => void;
}

export class BackgroundSubagentCoordinator {
    private readonly flushingParents = new Set<SessionId>();
    private readonly deferredIdleFlushes = new Set<SessionId>();
    private readonly pendingWriteQueues = new Map<SessionId, Promise<void>>();
    private readonly backgroundRuns = new Set<Promise<void>>();
    private readonly sessionRegistry: SessionRegistry;
    private readonly conversation: AgentConversationRuntime;
    private readonly runLifecycle: SubagentRunLifecycle;
    private readonly engines: Record<SubagentRuntime, AgentEngine>;
    private readonly workHooks: BackgroundWorkHooks | undefined;
    private readonly sessionsRoot: string;
    private readonly workspaceKey: WorkspaceId;
    private readonly backgroundInFlight = new Set<string>();
    private readonly settledEmitted = new Set<string>();
    private readonly executeSubagentSession: BackgroundSubagentCoordinatorOptions["executeSubagentSession"];
    private readonly runResume: BackgroundSubagentCoordinatorOptions["runResume"];
    private readonly trackInFlight: BackgroundSubagentCoordinatorOptions["trackInFlight"];
    private readonly hasChatRun: BackgroundSubagentCoordinatorOptions["hasChatRun"];
    private readonly settleChatRun: BackgroundSubagentCoordinatorOptions["settleChatRun"];
    private readonly emitEvent: BackgroundSubagentCoordinatorOptions["emit"];

    constructor(options: BackgroundSubagentCoordinatorOptions) {
        this.sessionRegistry = options.sessionRegistry;
        this.conversation = options.conversation;
        this.runLifecycle = options.runLifecycle;
        this.engines = options.engines;
        this.workHooks = options.workHooks;
        this.sessionsRoot = options.sessionsRoot;
        this.workspaceKey = options.workspaceKey;
        this.executeSubagentSession = options.executeSubagentSession;
        this.runResume = options.runResume;
        this.trackInFlight = options.trackInFlight;
        this.hasChatRun = options.hasChatRun;
        this.settleChatRun = options.settleChatRun;
        this.emitEvent = options.emit;
        this.sessionRegistry.on("session.attached", this.onAttached);
        this.sessionRegistry.on("session.idle", this.onIdle);
    }

    private readonly onAttached = ({ sessionId }: { sessionId: SessionId }): void => {
        void this.flush(sessionId);
    };

    private readonly onIdle = ({ sessionId }: { sessionId: SessionId }): void => {
        if (!this.workHooks?.beginParentNotice) return;
        if (this.flushingParents.has(sessionId)) this.deferredIdleFlushes.add(sessionId);
        else void this.flush(sessionId, true);
    };

    dispose(): void {
        this.sessionRegistry.off("session.attached", this.onAttached);
        this.sessionRegistry.off("session.idle", this.onIdle);
    }

    reserve(parentToolCallId: string): "duplicate" | "full" | undefined {
        if (this.backgroundInFlight.has(parentToolCallId)) return "duplicate";
        if (this.backgroundInFlight.size >= MAX_CONCURRENT_BACKGROUND_SUBAGENTS) return "full";
        this.backgroundInFlight.add(parentToolCallId);
    }

    release(parentToolCallId: string): void {
        this.backgroundInFlight.delete(parentToolCallId);
    }

    private emit(event: string, payload: unknown): void {
        this.emitEvent(event, payload);
    }

    private normalizedRuntime(runtime?: SubagentRuntime): SubagentRuntime {
        return runtime === "claude-code" || runtime === "codex" ? runtime : "standard";
    }

    async launch(
        sessionArgs: SubagentSessionArgs,
        def: AgentDefinition,
        description?: string,
    ): Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        background: true;
        resultPath: string;
    }> {
        const timeoutMs =
            def.timeoutMinutes !== undefined && def.timeoutMinutes > 0
                ? def.timeoutMinutes * 60_000
                : backgroundTimeoutMs(def.maxTurns);
        // The budget object is shared with the run (the reminder hook reads it
        // live), so the wall-clock allowance lands on the same state the turn
        // counter writes to.
        if (sessionArgs.budget) sessionArgs.budget.timeoutMs = timeoutMs;
        const controller = new AbortController();
        // The reason tells the runner this was the run's own budget running out,
        // not a user stop: the two need different words and different advice.
        const timer = setTimeout(
            () =>
                controller.abort({
                    kind: "subagent-timeout",
                    timeoutMinutes: Math.round(timeoutMs / 60_000),
                }),
            timeoutMs,
        );
        const { parentSessionId, parentToolCallId } = sessionArgs;
        // Generated here, not inside runSubagentSession, so the receipt below
        // can report it without waiting for the child session to actually be
        // created. If `repo.create()` subsequently fails, the receipt still
        // named a session that never came to exist — the failure surfaces
        // instead as an error notification once `run` settles (§ below),
        // which is the same "receipt now, truth later" trade-off `background`
        // makes everywhere else. The background slot was reserved by
        // `spawnSubagent` before any await; this method must not add it again.
        const childSessionId = sessionArgs.childSessionId ?? asSessionId(uuidv7());
        const runId = sessionArgs.executionId ?? uuidv7();
        this.conversation.begin(childSessionId, {
            runId,
            parentSessionId,
            runtime: sessionArgs.runtime,
            phase: "preparing",
        });
        // Computed at launch, not at settle: the receipt below carries it, so
        // the model holds the exact path from the moment it delegates. That is
        // what makes the result recoverable when the completion notice never
        // lands (parent mid-compaction, process restarted) — the model can read
        // the file on its own, and a missing file is itself the "still running"
        // answer. Deriving it here also keeps the path a single source of truth
        // shared by the receipt and the write.
        const resultPath = subagentResultPath(
            parentSessionId,
            childSessionId,
            this.sessionsRoot,
            sessionArgs.resume ? runId : undefined,
        );
        // Registered at launch (not when the run starts) so a stop request
        // that arrives during setup still reaches the run: the runner's
        // pre-aborted check turns it into an immediate interruption.
        const runScope = this.runLifecycle.acquire({
            sessionId: childSessionId,
            parentSessionId,
            controller,
        });
        // Recorded before the run starts: the Work must exist for the whole of
        // its run, or a crash mid-flight leaves nothing for the next start to
        // mark interrupted. Never throws; a failed record means no tracking.
        const workId = await this.workHooks?.onLaunch({
            workspace: this.workspaceKey,
            parentSessionId,
            parentToolCallId,
            childSessionId,
            agentType: sessionArgs.agentType,
            ...(description !== undefined ? { description } : {}),
        });

        // executeSubagentSession never throws (errors are `{ isError: true }`),
        // so `.then` always fires with a result. `.catch` covers
        // formatBackgroundNotification / deliverSubagentResult, and still
        // delivers an error envelope so the parent is not left with a receipt
        // that never settles.
        let workAttemptId: string | undefined;
        const execute = async (attemptId?: string) => {
            workAttemptId = attemptId;
            if (sessionArgs.resume)
                return this.trackInFlight(parentSessionId, parentToolCallId, () =>
                    this.runResume({
                        parentSessionId,
                        parentToolCallId,
                        subSessionId: childSessionId,
                        prompt: sessionArgs.prompt,
                        signal: controller.signal,
                        onUpdate: sessionArgs.onUpdate,
                        newTask: true,
                        managedExternally: true,
                        budget: sessionArgs.budget,
                        abortController: controller,
                        executionId: runId,
                    }),
                );
            return this.executeSubagentSession({
                ...sessionArgs,
                childSessionId,
                executionId: runId,
                backgroundLifecycle: true,
                signal: controller.signal,
                abortController: controller,
            });
        };
        const execution =
            workId &&
            this.workHooks?.run &&
            this.engines[this.normalizedRuntime(sessionArgs.runtime)].capabilities.workLane
                ? this.workHooks.run(workId, childSessionId, execute)
                : execute();
        let settledResult: SubagentRunResult | undefined;
        const run = execution
            .then(async (result) => {
                settledResult = { ...result, aborted: controller.signal.aborted || result.aborted };
                this.conversation.settling(childSessionId);
                if (result.waiting) {
                    if (workId !== undefined)
                        await this.workHooks?.onWaiting?.(workId, result.waiting, workAttemptId);
                    return;
                }
                // The timeout and `abortSubagentRun` fire the same controller,
                // so an aborted run reads as "aborted" here regardless of
                // which one stopped it — a deliberate stop, not a failure.
                const outcome =
                    controller.signal.aborted || result.aborted
                        ? ("aborted" as const)
                        : result.isError
                          ? ("error" as const)
                          : ("completed" as const);
                const path = await this.writeBackgroundResult(resultPath, result.resultText);
                // Result and delivery intent land in one Work snapshot before
                // anything else observes the settle. A crash after this line
                // still leaves a record that someone must be told.
                if (workId !== undefined) {
                    await this.workHooks?.onSettle(workId, parentSessionId, {
                        attemptId: workAttemptId,
                        outcome,
                        resultText: result.resultText,
                        partial: result.partial === true,
                        ...(path !== undefined ? { path } : {}),
                    });
                }
                // Emitted before delivery, not after: delivery starts a fresh
                // parent run, and a consumer that keyed "this background child
                // is still running" off the launch receipt must be able to
                // clear that state before the new run's events arrive.
                this.emitSettled(sessionArgs.agentType, {
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    outcome,
                });
                const notification = this.formatBackgroundNotification(sessionArgs.agentType, {
                    ...result,
                    outcome,
                    path,
                    description,
                });
                // Recorded before the attempt, so a delivery that never returns
                // (process killed mid-flight) still leaves a trace for the next
                // attach to flush. Cleared only once delivery actually lands.
                await this.recordPending({
                    workId,
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    agentType: sessionArgs.agentType,
                    outcome,
                    resultPath: path,
                    description,
                });
                // Only clear the pending record if the notice actually
                // reached the parent. A parent that is not currently attached
                // (process restarted, workspace disposed) returns `false`
                // here, not a throw — dropping the record in that case would
                // strand the notice forever: the record is the only thing
                // that makes `flush` retry it on the
                // next attach.
                //
                // Caught locally, not left to the outer `.catch`: the pending
                // record above already has the *real* outcome and result
                // path (e.g. "completed" with `path` pointing at the file
                // that was just written). Reaching the outer `.catch` from
                // here would have it fabricate a fallback "failed, output
                // unavailable" notice for a run that actually succeeded —
                // strictly worse than the record already made, which flush
                // will retry delivery from.
                try {
                    const delivered = await this.deliverNotice(
                        parentSessionId,
                        notification,
                        workId,
                    );
                    if (delivered) await this.dropPending(parentSessionId, parentToolCallId);
                } catch (e) {
                    log.error("background subagent delivery failed, will retry on next attach", {
                        parentSessionId,
                        parentToolCallId,
                        agentType: sessionArgs.agentType,
                        error: e instanceof Error ? e.message : String(e),
                    });
                }
            })
            .catch(async (e) => {
                log.error("background subagent settling failed", {
                    parentSessionId,
                    parentToolCallId,
                    agentType: sessionArgs.agentType,
                    error: e instanceof Error ? e.message : String(e),
                });
                // Reaching here means the run itself, emitSettled, or
                // writeBackgroundResult threw before a pending record could
                // be made — delivery failures are now caught locally above
                // and never reach this branch. There is no result text or
                // path to report here, only that the task did not complete
                // normally. `emitSettled` is idempotent per parentToolCallId,
                // so this is safe even if it already fired for this spawn.
                if (workId !== undefined) {
                    // No-op when `.then` already settled it: the first terminal
                    // state wins, so this cannot rewrite a finished Work.
                    await this.workHooks?.onSettle(workId, parentSessionId, {
                        outcome: "error",
                        attemptId: workAttemptId,
                        resultText: e instanceof Error ? e.message : String(e),
                        partial: false,
                    });
                }
                this.emitSettled(sessionArgs.agentType, {
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    outcome: "error",
                });
                const fallback = this.formatBackgroundNotification(sessionArgs.agentType, {
                    subSessionId: childSessionId,
                    resultText: e instanceof Error ? e.message : String(e),
                    outcome: "error",
                    description,
                });
                // recordPendingIfAbsent, not recordPending: guards against
                // this racing a `.then` recordPending call for the same
                // parentToolCallId — that record, if it exists, is always
                // at least as good as this fallback.
                await this.recordPendingIfAbsent({
                    workId,
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    agentType: sessionArgs.agentType,
                    outcome: "error",
                    description,
                });
                try {
                    const delivered = await this.deliverNotice(parentSessionId, fallback, workId);
                    if (delivered) await this.dropPending(parentSessionId, parentToolCallId);
                } catch (e2) {
                    log.error("background subagent fallback delivery failed", {
                        parentSessionId,
                        parentToolCallId,
                        error: e2 instanceof Error ? e2.message : String(e2),
                    });
                }
            })
            .finally(async () => {
                await this.conversation.end(childSessionId, runId, settledResult);
                clearTimeout(timer);
                this.release(parentToolCallId);
                this.backgroundRuns.delete(run);
                runScope.release();
                // Safe here, not in emitSettled: by the time this whole chain
                // settles, both the `.then` and `.catch` branches (the only
                // callers) have already run to completion, so no later call
                // for this same parentToolCallId can still be in flight to
                // race a fresh entry into existence. Without this the set
                // holds one string per background spawn for the process's
                // entire lifetime.
                this.settledEmitted.delete(`${parentToolCallId}:${runId}`);
            });
        // Deliberately not awaited or returned — see method doc. A rejection
        // from `run` is already handled by the `.catch` above, so there is no
        // unhandled-rejection risk in leaving it detached.
        //
        // Registered so the whole settle sequence — persist, record, deliver,
        // clear — has an observable end. Nothing in production waits on it, but
        // without a handle that sequence is only reachable by guessing how long
        // it takes, and it has already grown once (pending bookkeeping).
        this.backgroundRuns.add(run);
        void run;

        return {
            subSessionId: childSessionId,
            resultText: "",
            isError: false,
            background: true,
            resultPath,
        };
    }

    /**
     * Re-deliver notices this parent never received.
     *
     * Invoked on every `session.attached`. A session with nothing pending costs
     * one value read, which is why there is no "is this a parent" test — that
     * test would be a second source of truth about who can own pending entries.
     *
     * Delivery is sequential and each entry is cleared as it lands: a partial
     * flush (the parent goes busy halfway through) leaves the rest pending for
     * the next attach rather than dropping them.
     */
    async flush(parentSessionId: SessionId, trackedOnly = false): Promise<void> {
        if (this.flushingParents.has(parentSessionId)) return;
        this.flushingParents.add(parentSessionId);
        try {
            // Queued behind any in-flight recordPending/dropPending for this
            // parent, so this reads a consistent snapshot rather than racing
            // a concurrent settle's write.
            const pending = await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, (session) =>
                    readPendingSubagentResults(session),
                ),
            );
            const entries = Object.values(pending);
            if (entries.length === 0) return;
            log.info("flushing undelivered background subagent results", {
                parentSessionId,
                count: entries.length,
            });
            for (const entry of entries) {
                const workId =
                    entry.workId ??
                    this.workHooks?.workIdFor(
                        parentSessionId,
                        entry.parentToolCallId,
                        this.workspaceKey,
                    );
                const notification = this.formatBackgroundNotification(entry.agentType, {
                    subSessionId: entry.subSessionId,
                    resultText: "",
                    outcome: entry.outcome,
                    path: entry.resultPath,
                    description: entry.description,
                    late: true,
                });
                let delivered: boolean;
                try {
                    delivered = await this.deliverNotice(
                        parentSessionId,
                        notification,
                        workId,
                        trackedOnly,
                        entry.workId !== undefined,
                        entry.workId === undefined
                            ? this.workHooks?.workIdFor(parentSessionId, entry.parentToolCallId)
                            : undefined,
                    );
                } catch (e) {
                    // Still unreachable. Keep the entry and stop: the remaining
                    // ones would fail the same way, and a tight retry loop
                    // against a busy parent buys nothing.
                    log.warn("pending subagent result still undeliverable", {
                        parentSessionId,
                        parentToolCallId: entry.parentToolCallId,
                        error: e instanceof Error ? e.message : String(e),
                    });
                    return;
                }
                // `false` (not a throw) means the parent still is not
                // attached — same "stop here, keep the rest pending" outcome
                // as the caught-exception branch above, just via the normal
                // return path instead of an error.
                if (!delivered) {
                    // Idle retries must not replay a legacy live notice whose
                    // pending entry is still waiting for dropPending to run.
                    if (trackedOnly) continue;
                    log.warn("pending subagent result still undeliverable: parent not attached", {
                        parentSessionId,
                        parentToolCallId: entry.parentToolCallId,
                    });
                    return;
                }
                await this.dropPending(parentSessionId, entry.parentToolCallId);
            }
        } catch (e) {
            log.error("failed to flush pending subagent results", {
                parentSessionId,
                error: e instanceof Error ? e.message : String(e),
            });
        } finally {
            this.flushingParents.delete(parentSessionId);
            if (this.deferredIdleFlushes.delete(parentSessionId))
                void this.flush(parentSessionId, true);
        }
    }

    /**
     * Chain `run` onto this parent's pending-record queue and wait for it.
     *
     * `settled` swallows rejections so one failed link cannot poison the
     * queue for the next caller — the real result (and any throw) is still
     * awaited and surfaced below. Only the last-scheduled link clears the map
     * entry, or a queue still draining would lose its tail and let a later
     * caller run in parallel with an earlier one. Same shape as
     * `SessionRegistry.withSession`'s `detachedReads`.
     */
    private async withPendingQueue<T>(
        parentSessionId: SessionId,
        run: () => Promise<T>,
    ): Promise<T> {
        const previous = this.pendingWriteQueues.get(parentSessionId);
        const chained = (previous ?? Promise.resolve()).then(run);
        const settled = chained.then(
            () => undefined,
            () => undefined,
        );
        this.pendingWriteQueues.set(parentSessionId, settled);
        try {
            return await chained;
        } finally {
            if (this.pendingWriteQueues.get(parentSessionId) === settled) {
                this.pendingWriteQueues.delete(parentSessionId);
            }
        }
    }

    /**
     * Note a settled child whose notice has not been delivered yet.
     *
     * Bookkeeping must never be the reason a result is lost, so a failure here
     * is logged and swallowed: the delivery attempt that follows is the primary
     * path, and this only exists to make the retry possible if it fails.
     */
    private async recordPending(entry: {
        workId?: string;
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        runId?: string;
        agentType: string;
        outcome: "completed" | "error" | "aborted";
        resultPath?: string;
        description?: string;
    }): Promise<void> {
        const { parentSessionId, ...rest } = entry;
        try {
            await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, (session) =>
                    addPendingSubagentResult(session, { ...rest, settledAt: Date.now() }),
                ),
            );
        } catch (e) {
            log.error("failed to record pending subagent result", {
                parentSessionId,
                parentToolCallId: entry.parentToolCallId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Same as `recordPending`, but only writes when no record for this
     * `parentToolCallId` exists yet.
     *
     * Used by the `.catch` fallback path: reaching there after
     * `deliverSubagentResult` itself threw means the `.then` branch already
     * wrote the real outcome before the throw, and this must not clobber it
     * with a worse one. The read-then-write is inside `withPendingQueue` so
     * it cannot race the `.then` branch's own `recordPending` for the same
     * parent.
     */
    private async recordPendingIfAbsent(entry: {
        workId?: string;
        parentSessionId: SessionId;
        parentToolCallId: string;
        subSessionId: SessionId;
        runId?: string;
        agentType: string;
        outcome: "completed" | "error" | "aborted";
        resultPath?: string;
        description?: string;
    }): Promise<void> {
        const { parentSessionId, ...rest } = entry;
        try {
            await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, async (session) => {
                    const existing = await readPendingSubagentResults(session);
                    if (entry.parentToolCallId in existing) return;
                    await addPendingSubagentResult(session, { ...rest, settledAt: Date.now() });
                }),
            );
        } catch (e) {
            log.error("failed to record pending subagent result", {
                parentSessionId,
                parentToolCallId: entry.parentToolCallId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /** Clear a pending notice after it was delivered. Failures are logged, not raised. */
    private async dropPending(parentSessionId: SessionId, parentToolCallId: string): Promise<void> {
        try {
            await this.withPendingQueue(parentSessionId, () =>
                this.sessionRegistry.withSession(parentSessionId, (session) =>
                    clearPendingSubagentResult(session, parentToolCallId),
                ),
            );
        } catch (e) {
            log.error("failed to clear pending subagent result", {
                parentSessionId,
                parentToolCallId,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Emit `subagent.settled` once per background spawn.
     *
     * Both the success and the failure path call this, so it deduplicates on
     * `parentToolCallId` — a consumer that treats the event as "clear the
     * running marker" must not see a second one after the marker is gone and
     * a *new* spawn has reused nothing (ids are unique per tool call, so the
     * dedupe set only ever suppresses a genuine double-emit).
     */
    private emitSettled(
        agentType: string,
        args: {
            parentSessionId: SessionId;
            parentToolCallId: string;
            subSessionId: SessionId;
            runId?: string;
            outcome: "completed" | "error" | "aborted";
        },
    ): void {
        const key = `${args.parentToolCallId}:${args.runId ?? "legacy"}`;
        if (this.settledEmitted.has(key)) return;
        this.settledEmitted.add(key);
        const chatRunId = args.parentToolCallId.startsWith("chat:")
            ? args.parentToolCallId.slice(5)
            : undefined;
        if (chatRunId && this.hasChatRun(chatRunId)) {
            this.settleChatRun(chatRunId, args.outcome);
            return;
        }
        this.emit("subagent.settled", {
            parentSessionId: args.parentSessionId,
            parentToolCallId: args.parentToolCallId,
            subSessionId: args.subSessionId,
            agentType,
            ...(args.runId !== undefined ? { runId: args.runId } : {}),
            outcome: args.outcome,
        });
    }

    /**
     * Persist a background subagent's result text and return its path.
     *
     * Returns `undefined` when the write fails: a lost file degrades the
     * notification to "it finished, outcome X, text unavailable", which is
     * strictly better than dropping the notification altogether and leaving
     * the parent waiting on a child that already stopped.
     */
    private async writeBackgroundResult(
        path: string,
        resultText: string,
    ): Promise<string | undefined> {
        try {
            await mkdir(dirname(path), { recursive: true });
            // Published by rename: the parent reads this file as the child's
            // only answer, so a crash mid-write must not truncate it.
            await writeTextAtomic(path, resultText);
            return path;
        } catch (e) {
            log.error("failed to persist background subagent result", {
                path,
                error: e instanceof Error ? e.message : String(e),
            });
            return undefined;
        }
    }

    /**
     * Hand a settled notice to the parent and report whether it landed.
     *
     * With a Work attached, the notice run's reply is held back from the
     * channel and captured as the message to send. That is what makes the
     * outcome reliable: the reply is stored with the Work and delivered by
     * the Work deliverer, instead of leaving through a push that only logs a
     * failure.
     */
    private async deliverNotice(
        parentSessionId: SessionId,
        notification: string,
        workId: string | undefined,
        trackedOnly = false,
        tracked = true,
        legacyWorkId?: string,
    ): Promise<boolean> {
        const hooks = this.workHooks;
        if (!hooks || workId === undefined)
            return deliverSubagentResult(this.sessionRegistry, parentSessionId, notification);
        const decision = await hooks.beginParentNotice(
            workId,
            tracked,
            { workspace: this.workspaceKey, sessionId: parentSessionId },
            legacyWorkId,
        );
        if (decision.mode === "skip") return !decision.retry;
        if (decision.mode === "legacy") {
            if (trackedOnly) return false;
            return deliverSubagentResult(this.sessionRegistry, parentSessionId, notification);
        }
        workId = decision.workId ?? workId;

        let held = false;
        let ran = false;
        let reply: string | undefined;
        const release = (): void => {
            if (!held) return;
            held = false;
            hooks.onNoticeRunRelease(workId, parentSessionId);
        };
        try {
            const run = () =>
                deliverSubagentResultDetailed(this.sessionRegistry, parentSessionId, notification, {
                    enqueueWhenBusy: false,
                    beforePrompt: () => {
                        hooks.onNoticeRunStart(workId, parentSessionId, this.workspaceKey);
                        held = true;
                    },
                    afterPrompt: (text, didRun) => {
                        ran = didRun;
                        reply = text;
                        if (!didRun) release();
                    },
                });
            const outcome = hooks.runParentNotice
                ? await hooks.runParentNotice(workId, decision.claimId, parentSessionId, run)
                : await run();
            return outcome === "replied";
        } finally {
            try {
                await hooks.endParentNotice(workId, decision.claimId, {
                    status: ran ? "completed" : "not_run",
                    ...(reply === undefined ? {} : { reply }),
                });
            } finally {
                release();
            }
        }
    }

    /**
     * Envelope injected into the parent session once a background subagent
     * settles.
     *
     * Carries a *pointer*, not the answer: the result text is on disk, so the
     * parent's context pays for a path instead of an arbitrarily long transcript
     * it may never need. The `subagent_result` tag is registered `hidden`, so
     * none of this reaches the user's chat — which is why the body can afford to
     * spell out what the model should do next, including asking it to open with
     * a sentence acknowledging the result. Without that, the conversation would
     * jump straight from unrelated work to a background finding with no bridge.
     */
    private formatBackgroundNotification(
        agentType: string,
        result: {
            subSessionId: SessionId;
            resultText: string;
            outcome: "completed" | "error" | "aborted";
            path?: string;
            /**
             * The task label from the original `agent` call. Repeated here
             * because the notice can land many turns later: the conversation has
             * moved on, and a compaction in between may have collapsed the tool
             * call that would otherwise say what this subagent was for.
             */
            description?: string;
            /**
             * Re-delivery of a notice the parent missed while unreachable. Said
             * out loud because the model may have already told the user this
             * subagent was still running, and it needs to correct that rather
             * than present stale news as fresh.
             */
            late?: boolean;
        },
    ): string {
        const status = result.outcome;
        const located = result.path
            ? `Its full output is saved at: ${result.path}\nThat text is NOT included here — the file is the only copy.`
            : "Its output could not be saved to disk, so the detail is unavailable. Say so rather than guessing at it.";
        const guidance =
            result.outcome === "aborted"
                ? "This task was stopped deliberately — by the user or by its own time limit. Tell the user in one sentence that it was stopped, and do not restart or respawn it unless they ask."
                : result.outcome === "error"
                  ? "Read that file before replying: it holds the error and, if the subagent got partway, how far it got and whether it can be resumed. Then tell the user in one sentence that this background task failed, and propose a next step based on what you read. Do not present its output as a result."
                  : "Read that file with the read tool now, before you reply. Then tell the user, in your own words, that this background task came back and what it found — do not just hand them the path, and do not claim it is still running. If what you read changes what you were doing, say so.";
        const lateness = result.late
            ? " This notice is late — it could not be delivered when the subagent actually" +
              " finished, so if you previously told the user it was still running, correct that."
            : "";
        // In the body, not an attribute: `tagWrap` escapes attribute values but
        // not the body, and this is the one part of the envelope that is
        // model-authored text. The body is safe because the balanced parser does
        // not nest — a forged tag inside it stays inside it.
        const task = result.description ? `\nIts task was: ${result.description}` : "";
        return tagWrap(
            "subagent_result",
            `The ${agentType} subagent you launched in the background has finished (outcome: ${status}).` +
                `${lateness}${task}\n` +
                `${located}\n\n` +
                guidance,
            {
                "agent-type": agentType,
                session: result.subSessionId,
                outcome: status,
                ...(result.path ? { path: result.path } : {}),
                ...(result.late ? { late: "true" } : {}),
            },
        );
    }

    async whenBackgroundRunsSettle(): Promise<void> {
        while (this.backgroundRuns.size > 0) {
            await Promise.allSettled([...this.backgroundRuns]);
        }
    }
}
