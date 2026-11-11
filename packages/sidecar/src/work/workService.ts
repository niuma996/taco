/**
 * WorkService: wires the Work layer to the rest of the daemon.
 *
 * Owns the store, deliverer and controller, and implements the hooks the
 * subagent spawner calls. Everything that needs to know about channels or
 * routing lives here so the controller stays testable with plain fakes.
 */

import {
    type AgentMessage,
    type CommandPermissionRequest,
    type ImRoute,
    makeImCwd,
    type SessionId,
    type SessionTarget,
    WORK_REASON_MERGED,
    WORK_RESULT_TEXT_LIMIT,
    type WorkCancelResult,
    type WorkDeleteResult,
    type WorkGetResult,
    type WorkListResult,
    type WorkQueueCancelResult,
    type WorkRetryDeliveryResult,
} from "@taco-ai/protocol";
import type { ChannelRegistry } from "../channels/registry.ts";
import { createLogger } from "../lib/logger.ts";
import { withManagedOperation } from "../runtime/harness/operationExecution.ts";
import type { WaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import { resolveWaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import { type SettleWorkArgs, WorkController } from "./workController.ts";
import { type DeliveryClock, systemClock, WorkDeliverer } from "./workDelivery.ts";
import { WorkExecution } from "./workExecution.ts";
import type {
    BackgroundWorkHooks,
    ParentNoticeDecision,
    ParentNoticeOutcome,
    ScheduledFire,
    ScheduledFireSettle,
    ScheduledWorkHooks,
    WorkLaunch,
    WorkSettle,
} from "./workHooks.ts";
import { WorkMaintenance } from "./workMaintenance.ts";
import type {
    WorkAnswerContext,
    WorkAttemptHandle,
    WorkOperationRuntime,
} from "./workOperationTypes.ts";
import { WorkParentNotice } from "./workParentNotice.ts";
import { WorkPermissionProjection } from "./workPermissionProjection.ts";
import { WorkQueue } from "./workQueue.ts";
import { WorkQueueStore } from "./workQueueStore.ts";
import type { WorkQueueEntry } from "./workQueueTypes.ts";
import { WorkReconciler } from "./workReconciler.ts";
import { isSafeWorkId, legacyWorkIdForSource, WorkStore, workIdForSource } from "./workStore.ts";
import { isTerminal } from "./workTypes.ts";
import { buildList, toSummary, type WorkListArgs } from "./workView.ts";

const log = createLogger("sidecar.work.service");

export interface WorkServiceOptions {
    readonly operations?: WorkOperationRuntime;
    readonly root: string;
    readonly instanceId: string;
    readonly channels: Pick<ChannelRegistry, "sendText" | "maxMessageLength"> &
        Partial<Pick<ChannelRegistry, "getDeliveryBinding">>;
    /**
     * Session → IM route, or undefined when the session is not an IM
     * conversation. When the caller knows the workspace it is passed along:
     * the resolver must then scope the lookup to that workspace instead of
     * reverse-scanning every route for a bare session id another project
     * could also hold.
     */
    readonly resolveRoute: (sessionId: string, workspace?: string) => ImRoute | undefined;
    readonly clock?: DeliveryClock;
    readonly onChange?: (workId: string) => void;
    readonly onProjectionChange?: () => void;
    readonly resolveTargetState?: (
        workspace: string,
        sessionId: string,
    ) => Promise<"available" | "missing" | "unknown">;
    readonly queue?: {
        readonly root: string;
        execute(entry: WorkQueueEntry): Promise<AgentMessage>;
        recover(entry: WorkQueueEntry): Promise<void>;
    };
}

export interface QueueScheduledWork {
    readonly jobId: string;
    readonly fireId: string;
    readonly title: string;
    readonly workspace: string;
    readonly sessionId: string;
    readonly prompt: string;
    readonly createSession: boolean;
}

export interface QueueInboundWork {
    readonly batchId: string;
    readonly memberReceiptIds: readonly string[];
    readonly title: string;
    readonly workspace: string;
    readonly sessionId: string;
    readonly text: string;
    readonly media?: readonly import("../channels/types.ts").ChannelMediaRef[];
    readonly deliveryTarget: import("./workTypes.ts").DeliveryTarget;
}

/** What the `work.*` handlers need from the Work layer; nothing about stores or timers. */
export interface WorkControl {
    cancel(workId: string, attemptId: string): Promise<WorkCancelResult>;
    cancelQueue?(queueId: string, revision: number): Promise<WorkQueueCancelResult>;
    delete(workId: string): Promise<WorkDeleteResult>;
    sessionSkipped(target: SessionTarget): Promise<void>;
    list(args: WorkListArgs): Promise<WorkListResult>;
    get(workId: string): Promise<WorkGetResult>;
    retryDelivery(workId: string): Promise<WorkRetryDeliveryResult>;
    sessionDeleted(target: SessionTarget): Promise<void>;
    answerWaiting(
        target: SessionTarget,
        toolCallId: string,
        run: () => Promise<AgentMessage>,
        context?: WorkAnswerContext,
    ): Promise<AgentMessage>;
}

export class WorkService implements BackgroundWorkHooks, ScheduledWorkHooks, WorkControl {
    readonly store: WorkStore;
    readonly controller: WorkController;
    readonly deliverer: WorkDeliverer;
    private readonly maintenance: WorkMaintenance;
    private maintenanceStopped = false;
    private readonly reconciler: WorkReconciler;
    private readonly permissions: WorkPermissionProjection;
    private readonly parentNotices: WorkParentNotice;
    private readonly execution: WorkExecution;
    private readonly launchAttempts = new Map<string, string>();
    private readonly queue?: WorkQueue;
    private readonly queueWorkCallbacks = new Map<string, (workId: string) => void>();
    private readonly inboundReplyOwners = new Map<string, string>();

    constructor(private readonly options: WorkServiceOptions) {
        const clock = options.clock ?? systemClock;
        this.store = new WorkStore(options.root);
        // The deliverer reads notice runs through the controller, which needs the
        // deliverer to exist first; the closures resolve `controller` at call time.
        this.deliverer = new WorkDeliverer(this.store, options.channels, clock, options.onChange, {
            isCapturing: (workId) => this.controller.isCapturing(workId),
        });
        this.controller = new WorkController({
            store: this.store,
            deliverer: this.deliverer,
            instanceId: options.instanceId,
            now: () => clock.now(),
            onChange: options.onChange,
        });
        this.parentNotices = new WorkParentNotice(this.store, options.instanceId, () =>
            clock.now(),
        );
        this.execution = new WorkExecution(
            this.store,
            this.controller,
            options.operations,
            () => clock.now(),
            options.onChange ?? (() => undefined),
            options.instanceId,
        );
        this.reconciler = new WorkReconciler(
            this.store,
            this.controller,
            (workId, sessionId, run) => this.execution.run(workId, sessionId, run),
        );
        this.maintenance = new WorkMaintenance(async () => {
            await this.execution.recover();
            const result = await this.controller.maintain();
            await this.queue?.prune();
            return result;
        }, clock);
        this.permissions = new WorkPermissionProjection(options.instanceId, () =>
            options.onProjectionChange?.(),
        );
        if (options.queue) this.queue = this.createQueue(options.queue);
    }

    private createQueue(options: NonNullable<WorkServiceOptions["queue"]>): WorkQueue {
        return new WorkQueue(new WorkQueueStore(options.root), {
            prepare: async (entry) => {
                if (!entry.operation) throw new Error("queue operation is missing");
                const work =
                    entry.kind === "scheduled"
                        ? await this.controller.startScheduled({
                              sourceEventId: entry.sourceEventId,
                              jobId: entry.jobId ?? "unknown",
                              title: entry.title,
                              workspace: entry.workspace,
                              sessionId: entry.sessionId,
                              queueId: entry.queueId,
                              operation: entry.operation,
                          })
                        : await this.controller.startInbound({
                              sourceEventId: entry.sourceEventId,
                              title: entry.title,
                              workspace: entry.workspace,
                              sessionId: entry.sessionId,
                              sourceMemberIds: entry.sourceMemberIds ?? [],
                              maxMessageLength: this.options.channels.maxMessageLength(
                                  entry.deliveryTarget?.channelId ?? "",
                              ),
                              deliverTo: (() => {
                                  if (!entry.deliveryTarget)
                                      throw new Error("inbound queue delivery is missing");
                                  return entry.deliveryTarget;
                              })(),
                              queueId: entry.queueId,
                              operation: entry.operation,
                          });
                if (work.attempt.queueId !== entry.queueId)
                    throw Object.assign(
                        new Error("existing Work retains its legacy queue semantics"),
                        { code: "legacy_work" },
                    );
                const handle = {
                    workId: work.workId,
                    attemptId: work.attempt.attemptId,
                };
                if (entry.kind === "inbound")
                    this.inboundReplyOwners.set(
                        work.workId,
                        this.replyOwner(entry.workspace, entry.sessionId),
                    );
                this.queueWorkCallbacks.get(entry.queueId)?.(work.workId);
                this.queueWorkCallbacks.delete(entry.queueId);
                return handle;
            },
            readWork: async (entry) =>
                entry.work
                    ? ((await this.store.get(entry.work.workId))?.status ?? "missing")
                    : "missing",
            readAttempt: async (entry) =>
                entry.work
                    ? (await this.store.get(entry.work.workId))?.attempt.attemptId
                    : undefined,
            inspect: async (ref) => {
                if (!this.options.operations) return { kind: "missing" };
                return this.options.operations.inspect(ref);
            },
            execute: async (entry, admission) => {
                if (!entry.work) throw new Error("queue Work is not prepared");
                return this.execution.run(
                    entry.work.workId,
                    entry.sessionId,
                    () => options.execute(entry),
                    admission,
                );
            },
            settle: async (entry, outcome, message, reason) => {
                if (!entry.work) return;
                const waiting =
                    outcome === "completed"
                        ? resolveWaitingInteraction(message, entry.sessionId)
                        : undefined;
                if (waiting) {
                    await this.controller.waitForInput(
                        entry.work.workId,
                        waiting,
                        entry.work.attemptId,
                    );
                    return;
                }
                await this.controller.settle({
                    workId: entry.work.workId,
                    attemptId: entry.work.attemptId,
                    outcome,
                    resultText:
                        message?.role === "assistant"
                            ? message.content
                                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                                  .join("\n")
                            : "",
                    reason,
                    deliver: entry.kind === "inbound",
                    parentWillReply: false,
                });
                if (entry.kind === "inbound") this.inboundReplyOwners.delete(entry.work.workId);
            },
            cancel: async (entry) => {
                if (entry.work)
                    await this.execution.cancel(entry.work.workId, entry.work.attemptId);
            },
            recover: async (entry) => options.recover(entry),
        });
    }

    private replyOwner(workspace: string, sessionId: string): string {
        return JSON.stringify([workspace, sessionId]);
    }

    /** Used by the IM push sink only; desktop and session logs still receive every event. */
    ownsInboundReply(workspace: string, sessionId: string): boolean {
        return [...this.inboundReplyOwners.values()].includes(
            this.replyOwner(workspace, sessionId),
        );
    }

    /** Startup: close out Works whose process died, prune, then re-send what is still owed. */
    async start(): Promise<void> {
        await this.store.cleanupDeleted();
        await this.migrateLegacyWorkspaceKeys();
        for (const work of await this.store.list())
            if (work.kind === "inbound" && !isTerminal(work.status) && work.workspace)
                this.inboundReplyOwners.set(
                    work.workId,
                    this.replyOwner(work.workspace, work.parentSessionId),
                );
        try {
            const deferred = await this.execution.recover();
            const { interrupted, pruned } = await this.controller.reconcile(deferred);
            if (interrupted > 0 || pruned > 0) log.info("work reconciled", { interrupted, pruned });
            if (this.options.resolveTargetState) {
                const marked = await this.controller.reconcileTargets(
                    this.options.resolveTargetState,
                );
                if (marked > 0) log.info("work targets reconciled", { marked });
            }
        } catch (e) {
            log.error("work reconcile failed", { error: String(e) });
        }
        await this.controller.resumeDeliveries().catch((e: unknown) => {
            log.error("work delivery resume failed", { error: String(e) });
        });
        if (!this.maintenanceStopped) this.maintenance.start();
        await this.queue?.start();
    }

    /** Rewrite pre-2.11 IM Work snapshots that stored the physical scratch cwd. */
    private async migrateLegacyWorkspaceKeys(): Promise<void> {
        for (const record of await this.store.list()) {
            if (record.workspace?.startsWith("im://")) continue;
            // Scoped ids are immutable. Historical attribution needs the frozen
            // delivery target; a bare session id cannot establish project ownership.
            if (record.workId !== legacyWorkIdForSource(record.sourceEventId)) continue;
            const route = record.delivery?.target ?? record.deliveryTarget;
            if (!route) continue;
            const key = makeImCwd(route.channelId, route.peerId, route.chatId);
            await this.store.mutate(record.workId, (current) =>
                current.workspace === key
                    ? undefined
                    : { ...current, workspace: key, updatedAt: Date.now() },
            );
        }
    }

    /** A channel finished connecting: anything held back for it can go now. */
    onChannelConnected(): void {
        void this.controller.resumeDeliveries().catch((e: unknown) => {
            log.error("work delivery resume failed", { error: String(e) });
        });
    }

    stop(): void {
        this.queue?.stop();
        this.maintenanceStopped = true;
        this.maintenance.stop();
        this.deliverer.stop();
        this.permissions.clear();
        this.launchAttempts.clear();
    }

    async queueScheduled(
        request: QueueScheduledWork,
        onWork?: (workId: string) => void,
    ): Promise<{ workId?: string; status: string; reason?: string }> {
        if (!this.queue) throw new Error("independent Work queue is unavailable");
        let reported: string | undefined;
        const report = (workId: string) => {
            if (reported === workId) return;
            reported = workId;
            onWork?.(workId);
        };
        const queued = await this.queue.store.enqueue({
            sourceEventId: scheduledSourceEventId(request.jobId, request.fireId),
            kind: "scheduled",
            title: request.title,
            jobId: request.jobId,
            workspace: request.workspace,
            sessionId: request.sessionId,
            lane: "main",
            payload: { text: request.prompt },
            createSession: request.createSession,
        });
        if (onWork) {
            if (queued.entry.work) report(queued.entry.work.workId);
            else {
                this.queueWorkCallbacks.set(queued.entry.queueId, report);
                const current = await this.queue.store.get(queued.entry.queueId);
                if (current?.work) {
                    report(current.work.workId);
                    this.queueWorkCallbacks.delete(queued.entry.queueId);
                }
            }
        }
        this.queue.wake();
        const result = await this.queue.wait(queued.entry.queueId);
        this.queueWorkCallbacks.delete(queued.entry.queueId);
        return {
            ...(result.work ? { workId: result.work.workId } : {}),
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
        };
    }

    async enqueueInbound(request: QueueInboundWork): Promise<{ queueId: string }> {
        if (!this.queue) throw new Error("independent Work queue is unavailable");
        // Ordinary new input supersedes an old question; explicit answers use
        // session.submitAnswers and continue that Work with a fresh attempt.
        for (const work of await this.store.list()) {
            if (
                work.kind === "inbound" &&
                work.status === "waiting" &&
                work.workspace === request.workspace &&
                work.parentSessionId === request.sessionId
            )
                await this.execution.cancel(work.workId, work.attempt.attemptId);
        }
        const queued = await this.queue.store.enqueue({
            sourceEventId: `inbound:${request.batchId}`,
            kind: "inbound",
            title: request.title,
            workspace: request.workspace,
            sessionId: request.sessionId,
            lane: "main",
            payload: { text: request.text, ...(request.media ? { media: request.media } : {}) },
            sourceMemberIds: request.memberReceiptIds,
            deliveryTarget: request.deliveryTarget,
        });
        this.queue.wake();
        return { queueId: queued.entry.queueId };
    }

    async cancelQueue(queueId: string, revision: number): Promise<WorkQueueCancelResult> {
        if (!this.queue) return { outcome: "not_found" };
        return this.queue.cancel(queueId, revision);
    }

    // ── WorkControl (read side) ──

    sessionDeleted(target: SessionTarget): Promise<void> {
        return this.controller.sessionDeleted(target);
    }

    sessionSkipped(target: SessionTarget): Promise<void> {
        return this.execution.sessionSkipped(target.workspace, target.sessionId);
    }

    async cancellationRequested(
        workspace: string,
        sessionId: string,
        operationId: string,
    ): Promise<boolean> {
        for (const record of await this.store.list()) {
            const operation = record.attempt.operation;
            if (
                record.status === "running" &&
                record.attempt.cancelRequestedAt !== undefined &&
                operation?.workspace === workspace &&
                operation.sessionId === sessionId &&
                operation.operationId === operationId
            )
                return true;
        }
        return false;
    }

    run<T>(workId: string, sessionId: string, run: (attemptId: string) => Promise<T>): Promise<T> {
        return this.execution.run(workId, sessionId, run);
    }

    async cancel(workId: string, attemptId: string): Promise<WorkCancelResult> {
        if (!isSafeWorkId(workId)) return { outcome: "not_found", newlyRequested: false };
        const direct = await this.execution.cancel(workId, attemptId);
        if (direct.outcome !== "not_found") return direct;
        // A caller holding a pre-upgrade id still reaches the record.
        const resolved = await this.store.resolveId(workId);
        if (!resolved || resolved === workId) return direct;
        return this.execution.cancel(resolved, attemptId);
    }

    async delete(workId: string): Promise<WorkDeleteResult> {
        if (!isSafeWorkId(workId)) return { outcome: "not_found" };
        // Direct first: the tombstone must queue ahead of mutations the caller
        // already lined up behind this call. The alias lookup runs only on a
        // genuine miss.
        let outcome = await this.store.markDeleted(workId);
        if (outcome === "not_found") {
            const resolved = await this.store.resolveId(workId);
            if (resolved && resolved !== workId) {
                workId = resolved;
                outcome = await this.store.markDeleted(workId);
            }
        }
        if (outcome === "deleted") {
            this.options.onChange?.(workId);
            await this.deliverer.forget(workId);
            await this.store.delete(workId);
        }
        return { outcome };
    }

    async list(args: WorkListArgs): Promise<WorkListResult> {
        return buildList(
            (await this.store.list()).map((work) => this.permissions.project(work)),
            args,
            this.options.instanceId,
        );
    }

    async get(workId: string): Promise<WorkGetResult> {
        if (!isSafeWorkId(workId)) return { work: null };
        let record = await this.store.get(workId);
        if (!record) {
            const resolved = await this.store.resolveId(workId);
            if (resolved) {
                workId = resolved;
                record = await this.store.get(workId);
            }
        }
        if (!record) return { work: null };
        const work = toSummary(this.permissions.project(record));
        if (!record.result) return { work };
        const stored = await this.store.readResult(
            workId,
            record.result.resultId,
            record.result.checksum,
        );
        if (!stored) return { work };
        const truncated = stored.text.length > WORK_RESULT_TEXT_LIMIT;
        return {
            work,
            resultText: truncated ? stored.text.slice(0, WORK_RESULT_TEXT_LIMIT) : stored.text,
            ...(truncated ? { resultTruncated: true } : {}),
        };
    }

    permissionRequested(workspace: string, request: CommandPermissionRequest): void {
        this.permissions.requested(workspace, request);
    }

    permissionResolved(workspace: string, requestId: string): void {
        this.permissions.resolved(workspace, requestId);
    }

    async answerWaiting(
        target: SessionTarget,
        toolCallId: string,
        run: () => Promise<AgentMessage>,
        context?: WorkAnswerContext,
    ): Promise<AgentMessage> {
        const tracked = await this.store
            .list()
            .then((works) =>
                works.filter(
                    (work) =>
                        work.workspace === target.workspace &&
                        work.parentSessionId === target.sessionId &&
                        work.attempt.interaction?.toolCallId === toolCallId,
                ),
            )
            // This read only cleans the IM single-outlet projection. The
            // reconciler owns atomic answer admission and its legacy fallback.
            .catch(() => []);
        try {
            return await this.reconciler.answer(target, toolCallId, run, context);
        } finally {
            this.queue?.wake();
            for (const before of tracked) {
                const after = await this.store.get(before.workId);
                if (before.kind === "inbound" && after && isTerminal(after.status))
                    this.inboundReplyOwners.delete(before.workId);
            }
        }
    }

    async retryDelivery(workId: string): Promise<WorkRetryDeliveryResult> {
        if (!isSafeWorkId(workId)) return { outcome: "not_found" };
        const direct = await this.deliverer.retry(workId);
        if (direct !== "not_found") return { outcome: direct };
        const resolved = await this.store.resolveId(workId);
        if (!resolved || resolved === workId) return { outcome: direct };
        return { outcome: await this.deliverer.retry(resolved) };
    }

    // ── BackgroundWorkHooks ──

    workIdFor(parentSessionId: SessionId, parentToolCallId: string, workspace?: string): string {
        return workIdForSource(sourceEventIdFor(parentSessionId, parentToolCallId), workspace);
    }

    async onLaunch(launch: WorkLaunch): Promise<string | undefined> {
        try {
            // Frozen here, not at settle: a Work whose driver dies never settles,
            // and the user on the channel still has to be told it stopped.
            const route = this.options.resolveRoute(launch.parentSessionId, launch.workspace);
            const work = await this.controller.start({
                sourceEventId: sourceEventIdFor(launch.parentSessionId, launch.parentToolCallId),
                ...(launch.workspace !== undefined ? { workspace: launch.workspace } : {}),
                ...(route
                    ? {
                          deliverTo: {
                              ...route,
                              bindingId: this.options.channels.getDeliveryBinding?.(
                                  route.channelId,
                              ),
                          },
                          maxMessageLength: this.options.channels.maxMessageLength(route.channelId),
                      }
                    : {}),
                parentSessionId: launch.parentSessionId,
                childSessionId: launch.childSessionId,
                agentType: launch.agentType,
                title: launch.description ?? "",
            });
            this.launchAttempts.set(work.workId, work.attempt.attemptId);
            return work.workId;
        } catch (e) {
            // Tracking is additive. A store that cannot be written must not stop
            // the subagent from launching.
            log.error("work launch record failed", { error: String(e) });
            return undefined;
        }
    }

    async onSettle(workId: string, parentSessionId: SessionId, settle: WorkSettle): Promise<void> {
        try {
            const work = await this.store.get(workId);
            const route = this.options.resolveRoute(parentSessionId, work?.workspace);
            const attemptId = settle.attemptId ?? this.launchAttempts.get(workId);
            if (!attemptId) return;
            if (this.launchAttempts.get(workId) === attemptId) this.launchAttempts.delete(workId);
            await this.controller.settle({
                workId,
                attemptId,
                outcome: settle.outcome,
                resultText: settle.resultText,
                partial: settle.partial,
                path: settle.path,
                parentWillReply: route !== undefined,
            });
        } catch (e) {
            log.error("work settle failed", { workId, error: String(e) });
        }
    }

    async onWaiting(
        workId: string,
        waiting: WaitingInteraction,
        capturedAttemptId?: string,
    ): Promise<void> {
        try {
            const attemptId = capturedAttemptId ?? this.launchAttempts.get(workId);
            if (!attemptId) return;
            if (this.launchAttempts.get(workId) === attemptId) this.launchAttempts.delete(workId);
            await this.controller.waitForInput(workId, waiting, attemptId);
        } catch (e) {
            log.error("work waiting record failed", { workId, error: String(e) });
        }
    }

    async onResumeStart(
        childSessionId: SessionId,
        workspace?: string,
    ): Promise<WorkAttemptHandle | undefined> {
        try {
            const work = await this.store.findByChildSessionId(childSessionId, workspace);
            const resumed = work ? await this.controller.resumeAttempt(work.workId) : undefined;
            if (resumed?.status === "running")
                return { workId: resumed.workId, attemptId: resumed.attempt.attemptId };
        } catch (e) {
            log.error("work resume start failed", { childSessionId, error: String(e) });
        }
    }

    async onResumeSettle(
        childSessionId: SessionId,
        settle: WorkSettle,
        handle?: WorkAttemptHandle,
    ): Promise<void> {
        try {
            if (!handle) return;
            const work = await this.store.get(handle.workId);
            if (work?.childSessionId !== childSessionId) return;
            if (settle.waiting) {
                await this.controller.waitForInput(work.workId, settle.waiting, handle.attemptId);
                return;
            }
            await this.controller.settle({
                workId: work.workId,
                attemptId: handle.attemptId,
                outcome: settle.outcome,
                resultText: settle.resultText,
                partial: settle.partial,
                path: settle.path,
                // The resumed run reports through the parent conversation the
                // user just used; a second copy over the channel would repeat it.
                deliver: false,
                parentWillReply: false,
            });
        } catch (e) {
            log.error("work resume settle failed", { childSessionId, error: String(e) });
        }
    }

    // ── ScheduledWorkHooks ──

    async onFireQueued(workId: string, _entryId: string): Promise<void> {
        const result = await this.store.mutate(workId, (current) =>
            current.status === "running"
                ? {
                      ...current,
                      attempt: {
                          ...current.attempt,
                          operation: undefined,
                          operationAccepted: undefined,
                          sharedQueue: true,
                      },
                  }
                : undefined,
        );
        if (result?.changed) this.options.onChange?.(workId);
    }

    async onFire(fire: ScheduledFire): Promise<string | undefined> {
        try {
            const work = await this.controller.startScheduled({
                sourceEventId: scheduledSourceEventId(fire.jobId, fire.fireId),
                jobId: fire.jobId,
                title: fire.title,
                workspace: fire.workspace,
                sessionId: fire.sessionId,
            });
            this.launchAttempts.set(work.workId, work.attempt.attemptId);
            return work.workId;
        } catch (e) {
            log.error("scheduled work record failed", { jobId: fire.jobId, error: String(e) });
            return undefined;
        }
    }

    async onFireSettle(workId: string, settle: ScheduledFireSettle): Promise<void> {
        try {
            if (settle.outcome === "waiting") {
                await this.onWaiting(workId, settle.waiting);
                return;
            }
            const attemptId = this.launchAttempts.get(workId);
            if (!attemptId) return;
            this.launchAttempts.delete(workId);
            await this.controller.settle({
                workId,
                attemptId,
                ...settleArgs(settle),
                // The turn's reply reaches an IM peer through the session's own
                // channel; a notice from here would repeat it.
                deliver: false,
                parentWillReply: false,
            });
        } catch (e) {
            log.error("scheduled work settle failed", { workId, error: String(e) });
        }
    }

    async beginParentNotice(
        workId: string,
        tracked = true,
        parentTarget?: SessionTarget,
        legacyWorkId?: string,
    ): Promise<ParentNoticeDecision> {
        try {
            // A replay recomputes the composite id; a record from before ids
            // carried the workspace still owns the claim. An unknown id keeps
            // its old skip/retry verdict below.
            let resolved = isSafeWorkId(workId)
                ? await this.store.resolveIdentity(workId)
                : undefined;
            // Old pending entries have no stored Work id. Their producer can
            // supply the old hash, including tombstones with no source metadata.
            if (resolved?.kind === "missing" && legacyWorkId && isSafeWorkId(legacyWorkId))
                resolved = await this.store.resolveIdentity(legacyWorkId);
            if (resolved?.kind === "ambiguous") return { mode: "skip" };
            if (resolved?.kind === "found") workId = resolved.workId;
            const work = await this.store.get(workId);
            if (
                work &&
                parentTarget &&
                (work.workspace !== parentTarget.workspace ||
                    work.parentSessionId !== parentTarget.sessionId)
            )
                return { mode: "skip" };
            const target = work?.delivery?.target ?? work?.deliveryTarget;
            if (target) {
                if (!target.bindingId) return { mode: "skip" };
                const current = this.options.channels.getDeliveryBinding?.(target.channelId);
                if (!current) return { mode: "skip", retry: true };
                if (current !== target.bindingId) return { mode: "skip" };
            }
            const decision = await this.parentNotices.begin(workId, tracked);
            return decision.mode === "capture" || decision.mode === "silent"
                ? { ...decision, workId }
                : decision;
        } catch (error) {
            log.error("could not claim parent notification", { workId, error: String(error) });
            return { mode: "skip", retry: true };
        }
    }

    async endParentNotice(
        workId: string,
        claimId: string,
        outcome: ParentNoticeOutcome,
    ): Promise<void> {
        const resolved = isSafeWorkId(workId) ? await this.store.resolveId(workId) : undefined;
        if (resolved) workId = resolved;
        const before = await this.store.get(workId);
        if (before?.parentNotice?.claimId !== claimId) return;
        const attemptId = before.parentNotice.attemptId;
        const changed = await this.parentNotices.end(workId, claimId, outcome);
        if (!changed) return;
        if (outcome.status === "completed" && outcome.reply !== undefined)
            await this.controller.completeWithReply(workId, outcome.reply, attemptId);
        else await this.controller.replyFailed(workId, attemptId);
    }

    async runParentNotice<T>(
        workId: string,
        claimId: string,
        sessionId: string,
        run: () => Promise<T>,
    ): Promise<T> {
        const resolved = isSafeWorkId(workId) ? await this.store.resolveId(workId) : undefined;
        if (resolved) workId = resolved;
        const validate = async () => {
            const work = await this.store.get(workId);
            const claim = work?.parentNotice;
            if (
                !work ||
                !isTerminal(work.status) ||
                claim?.claimId !== claimId ||
                claim.attemptId !== work.attempt.attemptId ||
                claim.ownerInstanceId !== this.options.instanceId ||
                claim.state !== "claimed"
            )
                throw new Error("parent notice was superseded");
            const target = work?.delivery?.target ?? work?.deliveryTarget;
            if (
                target &&
                (!target.bindingId ||
                    this.options.channels.getDeliveryBinding?.(target.channelId) !==
                        target.bindingId)
            )
                throw new Error("parent notice channel binding changed");
            return work;
        };
        const snapshot = await validate();
        return withManagedOperation(
            {
                operationId: claimId,
                sessionId,
                beforeAccept: async () => {
                    await validate();
                },
                afterAccept: async () => {
                    try {
                        await validate();
                    } catch (error) {
                        if (!snapshot.workspace || !this.options.operations) throw error;
                        await this.options.operations.abort({
                            workspace: snapshot.workspace,
                            sessionId,
                            lane: "main",
                            operationId: claimId,
                        });
                    }
                },
            },
            run,
        );
    }

    onNoticeRunStart(workId: string, parentSessionId: SessionId, workspace?: string): void {
        this.controller.holdReplies(workId, parentSessionId, workspace);
    }

    onNoticeRunRelease(workId: string, _parentSessionId: SessionId): void {
        this.controller.releaseReplies(workId);
    }
}

export function sourceEventIdFor(parentSessionId: string, parentToolCallId: string): string {
    return `subagent:${parentSessionId}:${parentToolCallId}`;
}

function settleArgs(
    settle: Exclude<ScheduledFireSettle, { outcome: "waiting" }>,
): Pick<SettleWorkArgs, "outcome" | "resultText" | "reason"> {
    switch (settle.outcome) {
        case "completed":
            return { outcome: "completed", resultText: settle.replyText };
        case "merged":
            return {
                outcome: "completed",
                resultText: settle.replyText ?? "",
                reason: WORK_REASON_MERGED,
            };
        case "cancelled":
            return { outcome: "aborted", resultText: "", reason: settle.reason };
        case "error":
            return { outcome: "error", resultText: "", reason: settle.message };
    }
}

export function scheduledSourceEventId(jobId: string, fireId: string): string {
    return `job:${jobId}:${fireId}`;
}
