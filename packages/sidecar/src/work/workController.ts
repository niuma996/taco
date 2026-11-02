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

/** Beyond this many finished Works the oldest are removed, unless a delivery is open. */
export const WORK_RETENTION_COUNT = 500;

export interface StartWorkArgs {
    readonly sourceEventId: string;
    readonly parentSessionId: string;
    readonly childSessionId: string;
    readonly agentType: string;
    readonly title: string;
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

        const delivery = args.deliverTo
            ? buildDelivery({
                  route: args.deliverTo,
                  now,
                  parentWillReply: args.parentWillReply,
                  template: templateNotice({
                      agentType: current.agentType,
                      title: current.title,
                      outcome: args.outcome,
                      completeness,
                      excerpt: excerpt(args.resultText),
                      path: args.path,
                  }),
                  maxMessageLength: args.maxMessageLength,
              })
            : undefined;

        const settled = await this.store.mutate(args.workId, (work) => {
            const next = settle(work, { outcome: args.outcome, result, reason: args.reason, now });
            if (!next) return undefined;
            return delivery ? { ...next, delivery } : next;
        });
        if (!settled) return undefined;
        this.onChange(args.workId);

        if (delivery) {
            void this.deliverer.deliver(settled.workId);
        }
        return settled;
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
        const updated = await this.store.mutate(workId, (work) => {
            const d = work.delivery;
            if (d?.status !== "pending" || d.chunks) return undefined;
            return {
                ...work,
                updatedAt: this.now(),
                delivery: { ...d, status: "handedOff", awaitingParentReplyUntil: undefined },
            };
        });
        if (updated) this.onChange(workId);
    }

    private async freeze(
        workId: string,
        pick: (d: WorkDelivery) => {
            chunks: readonly string[];
            source: "parentReply" | "template";
        },
    ): Promise<void> {
        const updated = await this.store.mutate(workId, (work) => {
            const d = work.delivery;
            if (d?.status !== "pending" || d.chunks) return undefined;
            return {
                ...work,
                updatedAt: this.now(),
                delivery: { ...d, ...pick(d), awaitingParentReplyUntil: undefined },
            };
        });
        if (updated) {
            this.onChange(workId);
            void this.deliverer.deliver(workId);
        }
    }

    /** Re-send everything still open. Called at startup and when a channel connects. */
    async resumeDeliveries(): Promise<void> {
        await this.deliverer.resume();
    }

    /**
     * Startup pass: settle what pi already knows, and mark what was lost.
     *
     * Read-only toward pi on purpose. A Work whose operation is still open is
     * not touched here — the session's own attach recovery will finish it, and
     * the child's settle path then reaches `settle()` like any other. What this
     * pass handles is the Work whose driver process is gone: its in-memory
     * background run died with that process, so nothing will ever settle it.
     */
    async reconcile(): Promise<{ interrupted: number; pruned: number }> {
        const all = await this.store.list();
        let interrupted = 0;
        for (const work of all) {
            if (work.status !== "running" || work.ownerInstanceId === this.instanceId) continue;
            const next = await this.store.mutate(work.workId, (current) =>
                interrupt(current, {
                    reason: "the process that was running this stopped before it finished",
                    now: this.now(),
                }),
            );
            if (next?.status === "interrupted") {
                interrupted++;
                this.onChange(work.workId);
            }
        }
        const pruned = await this.prune(await this.store.list());
        return { interrupted, pruned };
    }

    private async prune(all: readonly WorkRecord[]): Promise<number> {
        const now = this.now();
        const removable = all
            .filter((w) => isTerminal(w.status) && w.delivery?.status !== "pending")
            .sort((a, b) => b.createdAt - a.createdAt);
        const doomed = new Set<string>();
        for (const w of removable) {
            if (now - w.createdAt > WORK_RETENTION_MS) doomed.add(w.workId);
        }
        for (const w of removable.slice(WORK_RETENTION_COUNT)) doomed.add(w.workId);
        for (const workId of doomed) await this.store.delete(workId);
        if (doomed.size > 0) log.info("pruned finished work", { count: doomed.size });
        return doomed.size;
    }
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
