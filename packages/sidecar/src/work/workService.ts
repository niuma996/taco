/**
 * WorkService: wires the Work layer to the rest of the daemon.
 *
 * Owns the store, deliverer and controller, and implements the hooks the
 * subagent spawner calls. Everything that needs to know about channels or
 * routing lives here so the controller stays testable with plain fakes.
 */

import type { ImRoute, SessionId } from "@taco-ai/protocol";
import type { ChannelRegistry } from "../channels/registry.ts";
import { createLogger } from "../lib/logger.ts";
import { WorkController } from "./workController.ts";
import { type DeliveryClock, systemClock, WorkDeliverer } from "./workDelivery.ts";
import type { BackgroundWorkHooks, WorkLaunch, WorkSettle } from "./workHooks.ts";
import { WorkStore, workIdForSource } from "./workStore.ts";

const log = createLogger("sidecar.work.service");

export interface WorkServiceOptions {
    readonly root: string;
    readonly instanceId: string;
    readonly channels: Pick<ChannelRegistry, "sendText" | "maxMessageLength">;
    /** Session → IM route, or undefined when the session is not an IM conversation. */
    readonly resolveRoute: (sessionId: string) => ImRoute | undefined;
    readonly clock?: DeliveryClock;
    readonly onChange?: (workId: string) => void;
}

export class WorkService implements BackgroundWorkHooks {
    readonly store: WorkStore;
    readonly controller: WorkController;
    readonly deliverer: WorkDeliverer;

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
    }

    /** Startup: close out Works whose process died, prune, then re-send what is still owed. */
    async start(): Promise<void> {
        try {
            const { interrupted, pruned } = await this.controller.reconcile();
            if (interrupted > 0 || pruned > 0) log.info("work reconciled", { interrupted, pruned });
        } catch (e) {
            log.error("work reconcile failed", { error: String(e) });
        }
        await this.controller.resumeDeliveries().catch((e: unknown) => {
            log.error("work delivery resume failed", { error: String(e) });
        });
    }

    /** A channel finished connecting: anything held back for it can go now. */
    onChannelConnected(): void {
        void this.controller.resumeDeliveries().catch((e: unknown) => {
            log.error("work delivery resume failed", { error: String(e) });
        });
    }

    stop(): void {
        this.deliverer.stop();
    }

    // ── BackgroundWorkHooks ──

    workIdFor(parentSessionId: SessionId, parentToolCallId: string): string {
        return workIdForSource(sourceEventIdFor(parentSessionId, parentToolCallId));
    }

    async onLaunch(launch: WorkLaunch): Promise<string | undefined> {
        try {
            const work = await this.controller.start({
                sourceEventId: sourceEventIdFor(launch.parentSessionId, launch.parentToolCallId),
                parentSessionId: launch.parentSessionId,
                childSessionId: launch.childSessionId,
                agentType: launch.agentType,
                title: launch.description ?? "",
            });
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
            await this.controller.settle({
                workId,
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
