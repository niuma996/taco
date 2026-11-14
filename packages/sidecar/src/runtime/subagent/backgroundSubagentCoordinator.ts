/** Coordinates background subagent settlement, durable notices, and retries. */

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { asSessionId, type SessionId, type WorkspaceId } from "@taco-ai/protocol";
import { MAX_AGENT_TURNS } from "../../agents/loadAgents.ts";
import type { AgentDefinition, SubagentRuntime } from "../../agents/types.ts";
import { createLogger } from "../../lib/logger.ts";
import { writeTextAtomic } from "../../store/atomicFile.ts";
import type { BackgroundWorkHooks, BackgroundWorkSettlement } from "../../work/workHooks.ts";
import { uuidv7 } from "../pi/values.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import type { AgentConversationRuntime } from "./agentConversationRuntime.ts";
import { normalizeSubagentRuntime } from "./engines/runtime.ts";
import type { AgentEngine } from "./engines/types.ts";
import type { SubagentEvents, SubagentExecution } from "./subagentCoordination.ts";
import { formatBackgroundNotification, SubagentNoticeDelivery } from "./subagentNoticeDelivery.ts";
import type { PendingSubagentResult } from "./subagentPending.ts";
import { SubagentPendingStore } from "./subagentPendingStore.ts";
import { subagentResultPath } from "./subagentResultsDir.ts";
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
    readonly execution: SubagentExecution;
    readonly events: SubagentEvents;
}

export class BackgroundSubagentCoordinator {
    private readonly flushingParents = new Set<SessionId>();
    private readonly deferredIdleFlushes = new Set<SessionId>();
    private readonly pending: SubagentPendingStore;
    private readonly notices: SubagentNoticeDelivery;
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
    private readonly execution: SubagentExecution;
    private readonly events: SubagentEvents;

    constructor(options: BackgroundSubagentCoordinatorOptions) {
        this.sessionRegistry = options.sessionRegistry;
        this.conversation = options.conversation;
        this.runLifecycle = options.runLifecycle;
        this.engines = options.engines;
        this.workHooks = options.workHooks;
        this.sessionsRoot = options.sessionsRoot;
        this.workspaceKey = options.workspaceKey;
        this.execution = options.execution;
        this.events = options.events;
        this.pending = new SubagentPendingStore(this.sessionRegistry);
        this.notices = new SubagentNoticeDelivery(
            this.sessionRegistry,
            this.workspaceKey,
            this.workHooks,
        );
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
        this.events.emit(event, payload);
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
        const resultPath = subagentResultPath(
            parentSessionId,
            childSessionId,
            this.sessionsRoot,
            sessionArgs.resume ? runId : undefined,
        );
        let runScope: ReturnType<SubagentRunLifecycle["acquire"]> | undefined;
        try {
            runScope = this.runLifecycle.acquire({
                sessionId: childSessionId,
                parentSessionId,
                controller,
            });
            this.conversation.begin(childSessionId, {
                runId,
                parentSessionId,
                runtime: sessionArgs.runtime,
                phase: "preparing",
            });
        } catch (error) {
            runScope?.release();
            this.release(parentToolCallId);
            throw error;
        }
        const scope = runScope;
        const timer = setTimeout(
            () =>
                controller.abort({
                    kind: "subagent-timeout",
                    timeoutMinutes: Math.round(timeoutMs / 60_000),
                }),
            timeoutMs,
        );
        // Recorded before the run starts: the Work must exist for the whole of
        // its run, or a crash mid-flight leaves nothing for the next start to
        // mark interrupted. Never throws; a failed record means no tracking.
        const workId = await Promise.resolve()
            .then(() =>
                this.workHooks?.onLaunch({
                    workspace: this.workspaceKey,
                    parentSessionId,
                    parentToolCallId,
                    childSessionId,
                    agentType: sessionArgs.agentType,
                    ...(description !== undefined ? { description } : {}),
                }),
            )
            .catch((error: unknown) => {
                log.error("work launch record failed", { error: String(error) });
                return undefined;
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
                return this.execution.track(parentSessionId, parentToolCallId, () =>
                    this.execution.resume({
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
            return this.execution.execute({
                ...sessionArgs,
                childSessionId,
                executionId: runId,
                backgroundLifecycle: true,
                signal: controller.signal,
                abortController: controller,
            });
        };
        const execution = Promise.resolve().then(() =>
            workId &&
            this.workHooks?.run &&
            this.engines[normalizeSubagentRuntime(sessionArgs.runtime)].capabilities.workLane
                ? this.workHooks.run(workId, childSessionId, execute)
                : execute(),
        );
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
                let outcome =
                    controller.signal.aborted || result.aborted
                        ? ("aborted" as const)
                        : result.isError
                          ? ("error" as const)
                          : ("completed" as const);
                let path = await this.writeBackgroundResult(resultPath, result.resultText);
                let settlement: BackgroundWorkSettlement | undefined;
                if (workId !== undefined) {
                    settlement =
                        (await this.workHooks?.onSettle(workId, parentSessionId, {
                            attemptId: workAttemptId,
                            outcome,
                            resultText: result.resultText,
                            partial: result.partial === true,
                            ...(path !== undefined ? { path } : {}),
                        })) || undefined;
                }
                if (settlement?.kind === "committed") {
                    outcome = settlement.outcome;
                    path = settlement.path;
                    workAttemptId = settlement.attemptId;
                } else if (settlement?.kind === "retry") {
                    workAttemptId = settlement.attemptId ?? workAttemptId;
                }
                this.emitSettled(sessionArgs.agentType, {
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    outcome,
                });
                if (settlement?.kind === "superseded") return;
                const notification = formatBackgroundNotification(sessionArgs.agentType, {
                    ...result,
                    outcome,
                    path,
                    description,
                });
                await this.recordPending({
                    workId,
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    attemptId: workAttemptId,
                    agentType: sessionArgs.agentType,
                    outcome,
                    resultPath: path,
                    description,
                    ...(settlement?.kind === "retry"
                        ? {
                              settlementPending: true,
                              partial: result.partial === true,
                              settlementText: result.resultText,
                          }
                        : {}),
                });
                if (settlement?.kind === "retry") return;
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
                    const delivered = await this.notices.deliverNotice(
                        parentSessionId,
                        notification,
                        workId,
                        false,
                        true,
                        undefined,
                        workAttemptId,
                    );
                    if (delivered)
                        await this.dropPending(parentSessionId, {
                            parentToolCallId,
                            runId,
                            settledAt: 0,
                        });
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
                let fallbackSettlement: BackgroundWorkSettlement | undefined;
                if (workId !== undefined) {
                    // No-op when `.then` already settled it: the first terminal
                    // state wins, so this cannot rewrite a finished Work.
                    fallbackSettlement =
                        (await this.workHooks?.onSettle(workId, parentSessionId, {
                            outcome: "error",
                            attemptId: workAttemptId,
                            resultText: e instanceof Error ? e.message : String(e),
                            partial: false,
                        })) || undefined;
                }
                const fallbackOutcome =
                    fallbackSettlement?.kind === "committed" ? fallbackSettlement.outcome : "error";
                this.emitSettled(sessionArgs.agentType, {
                    parentSessionId,
                    parentToolCallId,
                    subSessionId: childSessionId,
                    runId,
                    outcome: fallbackOutcome,
                });
                if (fallbackSettlement?.kind === "superseded") return;
                if (fallbackSettlement?.kind === "retry") {
                    await this.recordPending(
                        {
                            workId,
                            parentSessionId,
                            parentToolCallId,
                            subSessionId: childSessionId,
                            runId,
                            attemptId: fallbackSettlement.attemptId ?? workAttemptId,
                            agentType: sessionArgs.agentType,
                            outcome: "error",
                            settlementPending: true,
                            settlementText: e instanceof Error ? e.message : String(e),
                            description,
                        },
                        true,
                    );
                    return;
                }
                const fallback = formatBackgroundNotification(sessionArgs.agentType, {
                    subSessionId: childSessionId,
                    resultText: e instanceof Error ? e.message : String(e),
                    outcome: fallbackOutcome,
                    path:
                        fallbackSettlement?.kind === "committed"
                            ? fallbackSettlement.path
                            : undefined,
                    description,
                });
                // recordPendingIfAbsent, not recordPending: guards against
                // this racing a `.then` recordPending call for the same
                // parentToolCallId — that record, if it exists, is always
                // at least as good as this fallback.
                await this.recordPending(
                    {
                        workId,
                        parentSessionId,
                        parentToolCallId,
                        subSessionId: childSessionId,
                        runId,
                        attemptId:
                            fallbackSettlement?.kind === "committed"
                                ? fallbackSettlement.attemptId
                                : workAttemptId,
                        agentType: sessionArgs.agentType,
                        outcome: fallbackOutcome,
                        resultPath:
                            fallbackSettlement?.kind === "committed"
                                ? fallbackSettlement.path
                                : undefined,
                        description,
                    },
                    true,
                );
                try {
                    const delivered = await this.notices.deliverNotice(
                        parentSessionId,
                        fallback,
                        workId,
                        false,
                        true,
                        undefined,
                        fallbackSettlement?.kind === "committed"
                            ? fallbackSettlement.attemptId
                            : workAttemptId,
                    );
                    if (delivered)
                        await this.dropPending(parentSessionId, {
                            parentToolCallId,
                            runId,
                            settledAt: 0,
                        });
                } catch (e2) {
                    log.error("background subagent fallback delivery failed", {
                        parentSessionId,
                        parentToolCallId,
                        error: e2 instanceof Error ? e2.message : String(e2),
                    });
                }
            })
            .finally(async () => {
                try {
                    await this.conversation.end(childSessionId, runId, settledResult);
                } catch (error) {
                    log.error("background conversation cleanup failed", { error: String(error) });
                } finally {
                    clearTimeout(timer);
                    this.release(parentToolCallId);
                    this.backgroundRuns.delete(run);
                    scope.release();
                    // Safe here, not in emitSettled: by the time this whole chain
                    // settles, both the `.then` and `.catch` branches (the only
                    // callers) have already run to completion, so no later call
                    // for this same parentToolCallId can still be in flight to
                    // race a fresh entry into existence. Without this the set
                    // holds one string per background spawn for the process's
                    // entire lifetime.
                    this.settledEmitted.delete(`${parentToolCallId}:${runId}`);
                }
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
            const entries = await this.pending.read(parentSessionId);
            const managed = await this.workHooks?.pendingParentNotices?.({
                workspace: this.workspaceKey,
                sessionId: parentSessionId,
            });
            for (const notice of managed ?? []) {
                const pendingIndex = entries.findIndex(
                    (entry) =>
                        entry.workId === notice.workId && entry.attemptId === notice.attemptId,
                );
                if (pendingIndex >= 0) {
                    entries[pendingIndex] = {
                        ...entries[pendingIndex],
                        outcome: notice.outcome,
                        resultPath: notice.path,
                        settlementPending: false,
                    };
                    continue;
                }
                entries.push({
                    workId: notice.workId,
                    attemptId: notice.attemptId,
                    parentToolCallId: `work:${notice.workId}:${notice.attemptId}`,
                    subSessionId: asSessionId(notice.subSessionId),
                    agentType: notice.agentType,
                    description: notice.description,
                    outcome: notice.outcome,
                    resultPath: notice.path,
                    settledAt: 0,
                });
            }
            if (entries.length === 0) return;
            log.info("flushing undelivered background subagent results", {
                parentSessionId,
                count: entries.length,
            });
            for (const entry of entries) {
                if (entry.settlementPending && entry.workId && this.workHooks) {
                    const resultText =
                        (entry.resultPath
                            ? await readFile(entry.resultPath, "utf8").catch(() => undefined)
                            : undefined) ?? entry.settlementText;
                    if (resultText === undefined) continue;
                    const recoveredPath = await this.writeBackgroundResult(
                        entry.resultPath ??
                            subagentResultPath(
                                parentSessionId,
                                entry.subSessionId,
                                this.sessionsRoot,
                                entry.runId,
                            ),
                        resultText,
                    );
                    const settlement = await this.workHooks.onSettle(
                        entry.workId,
                        parentSessionId,
                        {
                            attemptId: entry.attemptId,
                            outcome: entry.outcome,
                            resultText,
                            partial: entry.partial === true,
                            path: recoveredPath,
                        },
                    );
                    if (settlement?.kind === "retry") continue;
                    if (settlement?.kind === "superseded") {
                        await this.dropPending(parentSessionId, entry);
                        continue;
                    }
                }
                const workId =
                    entry.workId ??
                    this.workHooks?.workIdFor(
                        parentSessionId,
                        entry.parentToolCallId,
                        this.workspaceKey,
                    );
                const notification = formatBackgroundNotification(entry.agentType, {
                    subSessionId: entry.subSessionId,
                    resultText: "",
                    outcome: entry.outcome,
                    path: entry.resultPath,
                    description: entry.description,
                    late: true,
                });
                let delivered: boolean;
                try {
                    delivered = await this.notices.deliverNotice(
                        parentSessionId,
                        notification,
                        workId,
                        trackedOnly,
                        entry.workId !== undefined,
                        entry.workId === undefined
                            ? this.workHooks?.workIdFor(parentSessionId, entry.parentToolCallId)
                            : undefined,
                        entry.attemptId,
                        true,
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
                await this.dropPending(parentSessionId, entry);
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

    private async recordPending(
        entry: Omit<PendingSubagentResult, "settledAt"> & {
            parentSessionId: SessionId;
        },
        onlyIfAbsent = false,
    ): Promise<void> {
        const { parentSessionId, ...rest } = entry;
        try {
            await this.pending.record(
                parentSessionId,
                { ...rest, settledAt: Date.now() },
                onlyIfAbsent,
            );
        } catch (error) {
            log.error("failed to record pending subagent result", {
                parentSessionId,
                error: String(error),
            });
        }
    }

    private async dropPending(
        parentSessionId: SessionId,
        entry: Pick<PendingSubagentResult, "parentToolCallId" | "runId" | "settledAt">,
    ): Promise<void> {
        try {
            await this.pending.remove(parentSessionId, entry);
        } catch (error) {
            log.error("failed to clear pending subagent result", {
                parentSessionId,
                error: String(error),
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
        if (chatRunId && this.events.settleChat(chatRunId, args.outcome)) return;
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

    /** Drain launched executions and their result delivery/cleanup chains. */
    async whenBackgroundRunsSettle(): Promise<void> {
        while (this.backgroundRuns.size > 0) {
            await Promise.allSettled([...this.backgroundRuns]);
        }
    }
}
