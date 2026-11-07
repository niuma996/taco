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
    type WorkGetResult,
    type WorkListResult,
    type WorkRetryDeliveryResult,
} from "@taco-ai/protocol";
import type { ChannelRegistry } from "../channels/registry.ts";
import { createLogger } from "../lib/logger.ts";
import type { WaitingInteraction } from "../runtime/session/waitingInteraction.ts";
import { type SettleWorkArgs, WorkController } from "./workController.ts";
import { type DeliveryClock, systemClock, WorkDeliverer } from "./workDelivery.ts";
import type {
    BackgroundWorkHooks,
    ScheduledFire,
    ScheduledFireSettle,
    ScheduledWorkHooks,
    WorkLaunch,
    WorkSettle,
} from "./workHooks.ts";
import { WorkPermissionProjection } from "./workPermissionProjection.ts";

import { WorkReconciler } from "./workReconciler.ts";
import { isSafeWorkId, WorkStore, workIdForSource } from "./workStore.ts";
import { buildList, toSummary, type WorkListArgs } from "./workView.ts";

const log = createLogger("sidecar.work.service");

export interface WorkServiceOptions {
    readonly root: string;
    readonly instanceId: string;
    readonly channels: Pick<ChannelRegistry, "sendText" | "maxMessageLength">;
    /** Session → IM route, or undefined when the session is not an IM conversation. */
    readonly resolveRoute: (sessionId: string) => ImRoute | undefined;
    readonly clock?: DeliveryClock;
    readonly onChange?: (workId: string) => void;
    readonly onProjectionChange?: () => void;
    readonly resolveTargetState?: (
        workspace: string,
        sessionId: string,
    ) => Promise<"available" | "missing" | "unknown">;
}

/** What the `work.*` handlers need from the Work layer; nothing about stores or timers. */
export interface WorkControl {
    list(args: WorkListArgs): Promise<WorkListResult>;
    get(workId: string): Promise<WorkGetResult>;
    retryDelivery(workId: string): Promise<WorkRetryDeliveryResult>;
    sessionDeleted(target: SessionTarget): Promise<void>;
    answerWaiting(
        target: SessionTarget,
        toolCallId: string,
        run: () => Promise<AgentMessage>,
    ): Promise<AgentMessage>;
}

export class WorkService implements BackgroundWorkHooks, ScheduledWorkHooks, WorkControl {
    readonly store: WorkStore;
    readonly controller: WorkController;
    readonly deliverer: WorkDeliverer;
    private readonly reconciler: WorkReconciler;
    private readonly permissions: WorkPermissionProjection;
    private readonly launchAttempts = new Map<string, string>();

    constructor(private readonly options: WorkServiceOptions) {
        const clock = options.clock ?? systemClock;
        this.store = new WorkStore(options.root);
        // The deliverer reads notice runs through the controller, which needs the
        // deliverer to exist first; the closures resolve `controller` at call time.
        this.deliverer = new WorkDeliverer(this.store, options.channels, clock, options.onChange, {
            isCapturing: (workId) => this.controller.isCapturing(workId),
            stopCapturing: (workId) => this.controller.stopCapturing(workId),
        });
        this.controller = new WorkController({
            store: this.store,
            deliverer: this.deliverer,
            instanceId: options.instanceId,
            now: () => clock.now(),
            onChange: options.onChange,
        });
        this.reconciler = new WorkReconciler(this.store, this.controller);
        this.permissions = new WorkPermissionProjection(options.instanceId, () =>
            options.onProjectionChange?.(),
        );
    }

    /** Startup: close out Works whose process died, prune, then re-send what is still owed. */
    async start(): Promise<void> {
        await this.migrateLegacyWorkspaceKeys();
        try {
            const { interrupted, pruned } = await this.controller.reconcile();
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
    }

    /** Rewrite pre-2.11 IM Work snapshots that stored the physical scratch cwd. */
    private async migrateLegacyWorkspaceKeys(): Promise<void> {
        for (const record of await this.store.list()) {
            if (record.workspace?.startsWith("im://")) continue;
            const route = this.options.resolveRoute(record.parentSessionId);
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
        this.deliverer.stop();
        this.permissions.clear();
        this.launchAttempts.clear();
    }

    // ── WorkControl (read side) ──

    sessionDeleted(target: SessionTarget): Promise<void> {
        return this.controller.sessionDeleted(target);
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
        const record = await this.store.get(workId);
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

    answerWaiting(
        target: SessionTarget,
        toolCallId: string,
        run: () => Promise<AgentMessage>,
    ): Promise<AgentMessage> {
        return this.reconciler.answer(target, toolCallId, run);
    }

    async retryDelivery(workId: string): Promise<WorkRetryDeliveryResult> {
        if (!isSafeWorkId(workId)) return { outcome: "not_found" };
        return { outcome: await this.deliverer.retry(workId) };
    }

    // ── BackgroundWorkHooks ──

    workIdFor(parentSessionId: SessionId, parentToolCallId: string): string {
        return workIdForSource(sourceEventIdFor(parentSessionId, parentToolCallId));
    }

    async onLaunch(launch: WorkLaunch): Promise<string | undefined> {
        try {
            // Frozen here, not at settle: a Work whose driver dies never settles,
            // and the user on the channel still has to be told it stopped.
            const route = this.options.resolveRoute(launch.parentSessionId);
            const work = await this.controller.start({
                sourceEventId: sourceEventIdFor(launch.parentSessionId, launch.parentToolCallId),
                ...(launch.workspace !== undefined ? { workspace: launch.workspace } : {}),
                ...(route
                    ? {
                          deliverTo: route,
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
            const route = this.options.resolveRoute(parentSessionId);
            const attemptId = this.launchAttempts.get(workId);
            this.launchAttempts.delete(workId);
            await this.controller.settle({
                workId,
                attemptId,
                outcome: settle.outcome,
                resultText: settle.resultText,
                partial: settle.partial,
                path: settle.path,
                ...(route
                    ? {
                          deliverTo: route,
                          maxMessageLength: this.options.channels.maxMessageLength(route.channelId),
                      }
                    : {}),
                parentWillReply: route !== undefined,
            });
        } catch (e) {
            log.error("work settle failed", { workId, error: String(e) });
        }
    }

    async onWaiting(workId: string, waiting: WaitingInteraction): Promise<void> {
        try {
            const attemptId = this.launchAttempts.get(workId);
            this.launchAttempts.delete(workId);
            await this.controller.waitForInput(workId, waiting, attemptId);
        } catch (e) {
            log.error("work waiting record failed", { workId, error: String(e) });
        }
    }

    async onResumeStart(childSessionId: SessionId): Promise<void> {
        try {
            const work = await this.store.findByChildSessionId(childSessionId);
            if (work) await this.controller.resumeAttempt(work.workId);
        } catch (e) {
            log.error("work resume start failed", { childSessionId, error: String(e) });
        }
    }

    async onResumeSettle(childSessionId: SessionId, settle: WorkSettle): Promise<void> {
        try {
            const work = await this.store.findByChildSessionId(childSessionId);
            if (!work) return;
            if (settle.waiting) {
                await this.controller.waitForInput(work.workId, settle.waiting);
                return;
            }
            await this.controller.settle({
                workId: work.workId,
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

    async noticeSettled(workId: string): Promise<boolean> {
        try {
            return await this.controller.isNoticeSettled(workId);
        } catch (e) {
            log.error("work notice check failed", { workId, error: String(e) });
            return false;
        }
    }

    async wantsNoticeReply(workId: string): Promise<boolean> {
        try {
            return await this.controller.awaitsReply(workId);
        } catch (e) {
            log.error("work notice lookup failed", { workId, error: String(e) });
            return false;
        }
    }

    onNoticeRunStart(workId: string, parentSessionId: SessionId): void {
        this.controller.holdReplies(workId, parentSessionId);
    }

    onNoticeRunRelease(workId: string, _parentSessionId: SessionId): void {
        this.controller.releaseReplies(workId);
    }

    async onNoticeRunEnd(workId: string, reply: string | undefined): Promise<void> {
        try {
            if (reply === undefined) await this.controller.replyFailed(workId);
            else await this.controller.completeWithReply(workId, reply);
        } catch (e) {
            log.error("work notice capture failed", { workId, error: String(e) });
        }
    }

    async onNoticeNotRun(workId: string, reason: "queued" | "unreachable"): Promise<void> {
        try {
            if (reason === "queued") await this.controller.handOff(workId);
            else await this.controller.replyFailed(workId);
        } catch (e) {
            log.error("work notice handoff failed", { workId, error: String(e) });
        }
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
