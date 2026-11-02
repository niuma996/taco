/**
 * WorkController: the one writer of Work records.
 *
 * It owns three things and nothing else:
 *
 *  - starting a Work (deduplicated by source event),
 *  - settling it — result and delivery intent committed in one snapshot, so a
 *    crash cannot leave a finished Work with no record that someone must be
 *    told,
 *  - the notice run: the parent model's own reply to a settled Work, captured
 *    and frozen as the message to send.
 *
 * It never drives an operation. The only thing the startup reconciler reads
 * from pi is a stored result; calling `resume` or `drive` from here would
 * race the attach-time recovery (see the Work plan, section 6).
 */

import type { ImRoute } from "@taco-ai/protocol";
import { chunkText } from "../channels/builtin/channelReply.ts";
import { createLogger } from "../lib/logger.ts";
import { uuidv7 } from "../runtime/pi/values.ts";
import { PARENT_REPLY_GRACE_MS, type WorkDeliverer } from "./workDelivery.ts";
import { completenessFor, interrupt, type SettleOutcome, settle } from "./workState.ts";
import { type WorkStore, workIdForSource } from "./workStore.ts";
import {
    isTerminal,
    WORK_SCHEMA_VERSION,
    type WorkDelivery,
    type WorkRecord,
    type WorkResultRef,
} from "./workTypes.ts";

const log = createLogger("sidecar.work.controller");

/** Chars of the answer kept on the record for list views. */
const SUMMARY_CHARS = 280;

/** Where the template notice cuts the answer; the full text stays on disk. */
const TEMPLATE_EXCERPT_CHARS = 600;

/** Records older than this are removed at startup, unless a delivery is open. */
export const WORK_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Beyond this many finished subagent Works the oldest are removed, unless a delivery is open. */
export const WORK_RETENTION_COUNT = 500;

/**
 * Finished Works kept per scheduled job, matching the job's own history ring.
 * Counted per job and apart from subagents: a job that fires every minute
 * would otherwise push every subagent result out of a shared budget in a day.
 */
export const SCHEDULED_WORK_RETENTION_PER_JOB = 20;

export interface StartWorkArgs {
    readonly sourceEventId: string;
    readonly workspace?: string;
    /** Where an interruption notice would go if the driver dies. */
    readonly deliverTo?: ImRoute;
    readonly maxMessageLength?: number;
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly agentType: string;
    readonly title: string;
}

export interface StartScheduledWorkArgs {
    readonly sourceEventId: string;
    readonly jobId: string;
    readonly title: string;
    readonly workspace: string;
    /** The session the fire's turn runs in. */
    readonly sessionId: string;
}

export interface SettleWorkArgs {
    readonly workId: string;
    readonly outcome: SettleOutcome;
    readonly resultText: string;
    readonly partial?: boolean;
    /** Where the answer was also written for the parent model to read. */
    readonly path?: string;
    readonly reason?: string;
    /** Set when the user who started this should be told, over IM. */
    readonly deliverTo?: ImRoute;
    /** Per-channel message cap, used to split the template notice. */
    readonly maxMessageLength?: number;
    /**
     * False when the result is already reaching the user another way (a resumed
     * run reports through the conversation), so no notice should be queued.
     */
    readonly deliver?: boolean;
    /** True when the parent model will be woken and expected to write the notice. */
    readonly parentWillReply: boolean;
}

export interface WorkControllerOptions {
    readonly store: WorkStore;
    readonly deliverer: WorkDeliverer;
    readonly instanceId: string;
    readonly now?: () => number;
    readonly onChange?: (workId: string) => void;
}

export class WorkController {
    private readonly store: WorkStore;
    private readonly deliverer: WorkDeliverer;
    private readonly instanceId: string;
    private readonly now: () => number;
    private readonly onChange: (workId: string) => void;

    /**
     * Notice runs in flight, by Work. Keyed per Work rather than per session so
     * that two children settling back to back each own their hold: one run
     * ending cannot lift the other's, and the deliverer can ask about one Work.
     */
    private readonly holds = new Map<string, { sessionId: string; count: number }>();

    constructor(options: WorkControllerOptions) {
        this.store = options.store;
        this.deliverer = options.deliverer;
        this.instanceId = options.instanceId;
        this.now = options.now ?? (() => Date.now());
        this.onChange = options.onChange ?? (() => undefined);
    }

    /**
     * Begin tracking a background launch. A repeat of the same source event
     * returns the existing Work instead of creating a second one.
     */
    /**
     * Begin tracking one fire of a scheduled job. Carries no delivery target:
     * the turn's own reply reaches an IM peer through the session's channel,
     * so a notice from here would say it twice.
     */
    async startScheduled(args: StartScheduledWorkArgs): Promise<WorkRecord> {
        const now = this.now();
        const workId = workIdForSource(args.sourceEventId);
        const record: WorkRecord = {
            schemaVersion: WORK_SCHEMA_VERSION,
            workId,
            revision: 0,
            kind: "scheduled",
            title: args.title,
            sourceEventId: args.sourceEventId,
            workspace: args.workspace,
            parentSessionId: args.sessionId,
            jobId: args.jobId,
            status: "running",
            ownerInstanceId: this.instanceId,
            createdAt: now,
            updatedAt: now,
            attempt: { attemptId: uuidv7(), startedAt: now },
        };
        const { record: stored, created } = await this.store.createIfAbsent(record);
        if (created) {
            this.onChange(workId);
            // Pruned on start rather than only at boot: a frequent job would
            // otherwise grow without bound between restarts.
            if (stored.jobId !== undefined) {
                await this.pruneJob(stored.jobId).catch((e: unknown) => {
                    log.warn("scheduled work prune failed", { workId, error: String(e) });
                });
            }
        }
        return stored;
    }

    async start(args: StartWorkArgs): Promise<WorkRecord> {
        const now = this.now();
        const workId = workIdForSource(args.sourceEventId);
        const record: WorkRecord = {
            schemaVersion: WORK_SCHEMA_VERSION,
            workId,
            revision: 0,
            kind: "subagent",
            title: args.title,
            sourceEventId: args.sourceEventId,
            ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
            ...(args.deliverTo
                ? {
                      deliveryTarget: {
                          channelId: args.deliverTo.channelId,
                          peerId: args.deliverTo.peerId,
                          chatId: args.deliverTo.chatId,
                      },
                  }
                : {}),
            ...(args.maxMessageLength !== undefined
                ? { maxMessageLength: args.maxMessageLength }
                : {}),
            parentSessionId: args.parentSessionId,
            childSessionId: args.childSessionId,
            agentType: args.agentType,
            status: "running",
            ownerInstanceId: this.instanceId,
            createdAt: now,
            updatedAt: now,
            attempt: { attemptId: uuidv7(), startedAt: now },
        };
        const { record: stored, created } = await this.store.createIfAbsent(record);
        if (created) this.onChange(workId);
        return stored;
    }

    /**
     * Commit the result and the delivery intent together, then wake the
     * deliverer. A Work that already ended is left as it was.
     */
    async settle(args: SettleWorkArgs): Promise<WorkRecord | undefined> {
        const now = this.now();
        const current = await this.store.get(args.workId);
        if (!current || isTerminal(current.status)) return current;

        const hasText = args.resultText.trim().length > 0;
        const completeness = completenessFor({
            outcome: args.outcome,
            partial: args.partial,
            hasText,
        });
        let result: WorkResultRef | undefined;
        if (hasText) {
            const stored = await this.store.writeResult({
                workId: args.workId,
                attemptId: current.attempt.attemptId,
                text: args.resultText,
                now,
            });
            result = {
                resultId: stored.resultId,
                checksum: stored.checksum,
                completeness,
                summary: summarize(args.resultText),
                ...(args.path ? { path: args.path } : {}),
            };
        } else {
            result = {
                resultId: "",
                checksum: "",
                completeness: "unavailable",
                summary: "",
                ...(args.path ? { path: args.path } : {}),
            };
        }

        const target =
            args.deliver === false ? undefined : (args.deliverTo ?? current.deliveryTarget);
        const maxMessageLength = args.maxMessageLength ?? current.maxMessageLength;
        const delivery = target
            ? buildDelivery({
                  route: target,
                  now,
                  parentWillReply: args.parentWillReply,
                  template: templateNotice({
                      agentType: current.agentType ?? "",
                      title: current.title,
                      outcome: args.outcome,
                      completeness,
                      excerpt: excerpt(args.resultText),
                      path: args.path,
                  }),
                  maxMessageLength,
              })
            : undefined;

        const res = await this.store.mutate(args.workId, (work) => {
            const next = settle(work, { outcome: args.outcome, result, reason: args.reason, now });
            if (!next) return undefined;
            return delivery ? { ...next, delivery } : next;
        });
        if (!res) return undefined;
        // A Work that already ended keeps its outcome, and this call must not
        // push or deliver on its behalf: the delivery computed above describes
        // an outcome the record did not take.
        if (!res.changed) return res.record;
        this.onChange(args.workId);
        if (delivery) void this.deliverer.deliver(args.workId);
        return res.record;
    }

    /**
     * Reopen an interrupted Work for a resumed run. Only `interrupted` may be
     * reopened: a completed Work stays completed, and a failed one did not fail
     * for a reason a resume changes.
     */
    async resumeAttempt(workId: string): Promise<WorkRecord | undefined> {
        const now = this.now();
        const res = await this.store.mutate(workId, (current) => {
            if (current.status !== "interrupted") return undefined;
            // The resume is happening because the user is in the conversation.
            // An interruption notice still waiting to go out is now stale and
            // would land after the result they are about to see.
            const delivery =
                current.delivery?.status === "pending"
                    ? {
                          ...current.delivery,
                          status: "cancelled" as const,
                          nextAttemptAt: undefined,
                      }
                    : current.delivery;
            return {
                ...current,
                status: "running" as const,
                updatedAt: now,
                endedAt: undefined,
                reason: undefined,
                ...(delivery ? { delivery } : {}),
                attempt: { attemptId: uuidv7(), startedAt: now },
            };
        });
        if (!res?.changed) return res?.record;
        this.onChange(workId);
        return res.record;
    }

    /** Whether this Work's outcome already reached the user another way. */
    async isNoticeSettled(workId: string): Promise<boolean> {
        const status = (await this.store.get(workId))?.delivery?.status;
        return status === "confirmed" || status === "handedOff" || status === "cancelled";
    }

    /** A notice run for `workId` started: capture the session's text instead of sending it live. */
    holdReplies(workId: string, sessionId: string): void {
        const hold = this.holds.get(workId);
        this.holds.set(workId, { sessionId, count: (hold?.count ?? 0) + 1 });
    }

    /** The notice run ended. Exactly once per `holdReplies`, including on failure. */
    releaseReplies(workId: string): void {
        const hold = this.holds.get(workId);
        if (!hold) return;
        if (hold.count > 1) this.holds.set(workId, { ...hold, count: hold.count - 1 });
        else this.holds.delete(workId);
    }

    /** Whether the channel should keep this session's assistant text to itself. */
    isHoldingReplies(sessionId: string): boolean {
        for (const hold of this.holds.values()) if (hold.sessionId === sessionId) return true;
        return false;
    }

    /** Whether a notice run is still writing this Work's message. */
    isCapturing(workId: string): boolean {
        return this.holds.has(workId);
    }

    /**
     * The template was frozen while a notice run was still writing. Stop
     * holding that run's text: its reply can no longer become the message, so
     * keeping it from the channel would lose it rather than deduplicate it.
     */
    stopCapturing(workId: string): void {
        this.holds.delete(workId);
    }

    /** Whether this Work's delivery is still waiting for the parent model's reply. */
    async awaitsReply(workId: string): Promise<boolean> {
        const d = (await this.store.get(workId))?.delivery;
        return d?.status === "pending" && d.chunks === undefined;
    }

    /**
     * The parent model answered the notice. Freeze its reply as the message
     * and start delivering. A reply with no text falls back to the template.
     */
    async completeWithReply(workId: string, text: string): Promise<void> {
        const trimmed = text.trim();
        if (trimmed === "") return this.replyFailed(workId);
        await this.freeze(workId, (d) => ({
            chunks: chunkText(trimmed, d.maxMessageLength),
            source: "parentReply",
        }));
    }

    /**
     * No reply is coming (parent unreachable, run failed, or it said nothing):
     * send the template now instead of waiting out the grace period.
     */
    async replyFailed(workId: string): Promise<void> {
        await this.freeze(workId, (d) => ({
            chunks: d.templateChunks ?? [],
            source: "template",
        }));
    }

    /**
     * The notice went into the parent's follow-up queue because it was mid-turn.
     * Its own reply will carry the news through the ordinary channel path, so
     * a second copy from here would only repeat it.
     */
    async handOff(workId: string): Promise<void> {
        const res = await this.store.mutate(workId, (work) => {
            const d = work.delivery;
            if (d?.status !== "pending" || d.chunks) return undefined;
            return {
                ...work,
                updatedAt: this.now(),
                delivery: { ...d, status: "handedOff", awaitingParentReplyUntil: undefined },
            };
        });
        if (res?.changed) this.onChange(workId);
    }

    private async freeze(
        workId: string,
        pick: (d: WorkDelivery) => {
            chunks: readonly string[];
            source: "parentReply" | "template";
        },
    ): Promise<void> {
        const res = await this.store.mutate(workId, (work) => {
            const d = work.delivery;
            if (d?.status !== "pending" || d.chunks) return undefined;
            return {
                ...work,
                updatedAt: this.now(),
                delivery: { ...d, ...pick(d), awaitingParentReplyUntil: undefined },
            };
        });
        if (res?.changed) {
            this.onChange(workId);
            void this.deliverer.deliver(workId);
        }
    }

    /** Re-send everything still open. Called at startup and when a channel connects. */
    async resumeDeliveries(): Promise<void> {
        await this.deliverer.resume();
    }

    /**
     * Startup pass: mark Works whose driver process is gone, then prune.
     *
     * Read-only toward pi on purpose: deciding whether a stored operation is
     * still resumable would mean attaching every child session at startup, which
     * is exactly the cost this pass exists to avoid. So "interrupted" here means
     * "the driver died", not "the run is unrecoverable": a later `agentContinue`
     * reopens the Work through `resumeAttempt`, and a settle from that run
     * closes it normally. The reason text says so.
     */
    async reconcile(): Promise<{ interrupted: number; pruned: number }> {
        const all = await this.store.list();
        let interrupted = 0;
        for (const work of all) {
            if (work.status !== "running" || work.ownerInstanceId === this.instanceId) continue;
            const now = this.now();
            const next = await this.store.mutate(work.workId, (current) => {
                const stopped = interrupt(current, {
                    reason:
                        current.kind === "scheduled"
                            ? "the process that was running this stopped before it finished; " +
                              "the job runs again at its next scheduled time"
                            : "the process that was running this stopped before it finished; " +
                              "continue the subagent to finish it",
                    now,
                });
                if (!stopped) return undefined;
                // The user who launched this is on the other end of a channel and
                // has no other way to learn it stopped. Queue the notice now: the
                // target was frozen at launch precisely for this case.
                return withInterruptionNotice(stopped, now);
            });
            if (next?.changed) {
                interrupted++;
                this.onChange(work.workId);
                if (next.record.delivery) void this.deliverer.deliver(work.workId);
            }
        }
        const pruned = await this.prune(await this.store.list());
        return { interrupted, pruned };
    }

    private async prune(all: readonly WorkRecord[]): Promise<number> {
        const doomed = pruneTargets(all, this.now());
        for (const workId of doomed) await this.store.delete(workId);
        if (doomed.size > 0) log.info("pruned finished work", { count: doomed.size });
        return doomed.size;
    }

    /** Keep one job's finished fires within its own budget. */
    private async pruneJob(jobId: string): Promise<void> {
        const fires = (await this.store.list()).filter((w) => w.jobId === jobId);
        const doomed = pruneTargets(fires, this.now());
        for (const workId of doomed) {
            await this.store.delete(workId);
            this.onChange(workId);
        }
    }
}

/**
 * Finished Works past their retention, by kind: subagents share one budget,
 * each scheduled job has its own. A Work with a notice still pending stays,
 * whatever its age — removing it would lose a message someone is owed.
 */
export function pruneTargets(all: readonly WorkRecord[], now: number): Set<string> {
    const removable = all
        .filter((w) => isTerminal(w.status) && w.delivery?.status !== "pending")
        .sort((a, b) => b.createdAt - a.createdAt);
    const doomed = new Set<string>();
    for (const w of removable) {
        if (now - w.createdAt > WORK_RETENTION_MS) doomed.add(w.workId);
    }
    const subagents = removable.filter((w) => w.kind !== "scheduled");
    for (const w of subagents.slice(WORK_RETENTION_COUNT)) doomed.add(w.workId);
    const byJob = new Map<string, WorkRecord[]>();
    for (const w of removable) {
        if (w.kind !== "scheduled" || w.jobId === undefined) continue;
        const fires = byJob.get(w.jobId) ?? [];
        fires.push(w);
        byJob.set(w.jobId, fires);
    }
    for (const fires of byJob.values()) {
        for (const w of fires.slice(SCHEDULED_WORK_RETENTION_PER_JOB)) doomed.add(w.workId);
    }
    return doomed;
}

function summarize(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= SUMMARY_CHARS ? flat : `${flat.slice(0, SUMMARY_CHARS - 1)}…`;
}

function excerpt(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= TEMPLATE_EXCERPT_CHARS) return trimmed;
    return `${trimmed.slice(0, TEMPLATE_EXCERPT_CHARS - 1)}…`;
}

interface TemplateArgs {
    readonly agentType: string;
    readonly title: string;
    readonly outcome: SettleOutcome;
    readonly completeness: "full" | "partial" | "unavailable";
    readonly excerpt: string;
    readonly path?: string;
}

/**
 * The fallback notice. Plain text, no local paths: the peer is on a phone and
 * a filesystem path on the user's machine means nothing there (and says
 * something about the machine it should not).
 */
export function templateNotice(args: TemplateArgs): string {
    const label = args.title.trim() === "" ? args.agentType : args.title.trim();
    const headline =
        args.outcome === "completed"
            ? `Background task finished: ${label}`
            : args.outcome === "aborted"
              ? `Background task was stopped: ${label}`
              : `Background task failed: ${label}`;
    const lines = [headline];
    if (args.completeness === "partial") {
        lines.push("The answer below is partial: the task did not run to completion.");
    }
    if (args.excerpt !== "") {
        lines.push("", args.excerpt);
    } else {
        lines.push("", "No output was produced.");
    }
    return lines.join("\n");
}

/** The notice sent when the process driving a Work died before it settled. */
export function interruptionNotice(args: { title: string; agentType?: string }): string {
    const label = args.title.trim() === "" ? (args.agentType ?? "") : args.title.trim();
    return [
        `Background task was interrupted: ${label}`,
        "",
        "The process running it stopped before it finished. If its conversation is still " +
            "available, continuing the subagent can finish the task.",
    ].join("\n");
}

/**
 * Attach a ready-to-send interruption notice. Frozen here rather than at send
 * time so a restart with the channel down still has something to retry with.
 */
function withInterruptionNotice(record: WorkRecord, now: number): WorkRecord {
    if (record.delivery || !record.deliveryTarget) return record;
    const cap = record.maxMessageLength ?? 2000;
    return {
        ...record,
        delivery: {
            deliveryId: uuidv7(),
            target: record.deliveryTarget,
            status: "pending",
            chunks: chunkText(interruptionNotice(record), cap),
            source: "template",
            maxMessageLength: cap,
            confirmedChunks: 0,
            attempts: 0,
            createdAt: now,
        },
    };
}

function buildDelivery(args: {
    route: ImRoute;
    now: number;
    parentWillReply: boolean;
    template: string;
    maxMessageLength?: number;
}): WorkDelivery {
    const cap = args.maxMessageLength ?? 2000;
    const templateChunks = chunkText(args.template, cap);
    return {
        deliveryId: uuidv7(),
        target: {
            channelId: args.route.channelId,
            peerId: args.route.peerId,
            chatId: args.route.chatId,
        },
        status: "pending",
        confirmedChunks: 0,
        attempts: 0,
        createdAt: args.now,
        maxMessageLength: cap,
        templateChunks,
        ...(args.parentWillReply
            ? { awaitingParentReplyUntil: args.now + PARENT_REPLY_GRACE_MS }
            : { chunks: templateChunks, source: "template" as const }),
    };
}
