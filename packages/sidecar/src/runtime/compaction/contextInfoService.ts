/**
 * ContextInfoService — session context-usage queries + context-info assembly.
 *
 * cacheHitRatio = ΣcacheRead / Σ(input + cacheRead).
 * Denominator excludes `cacheWrite` (first-turn prefix is unavoidable) and
 * `output` (pi compaction uses `cacheRetention: "none"`; summary would dilute the
 * ratio). `getSessionStats()` only exposes merged `uncachedTokens = Σ(input +
 * cacheWrite)`, so we walk `session.findEntries()` ourselves for one-pass
 * accumulation.
 */

import type { SessionContextInfoResult } from "@taco-ai/protocol";
import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type { AgentLane, Api, Entry, Model, Session } from "../pi/types.ts";
import { estimateContextTokens } from "../pi/values.ts";
import { buildBranchContext, MAIN_BRANCH } from "../session/sessionBranch.ts";

const log = createLogger("contextInfoService");

/** The provider usage shape we read off session entries (subset of pi-ai `Usage`). */
interface EntryUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost?: { total?: number };
}

/**
 * Extract the usage record off one session entry, mirroring pi's
 * `getSessionStats` exactly: only assistant `message` entries and
 * `compaction` / `branch_summary` entries carry usage, and every numeric
 * field must be present (an entry with a partial usage record is skipped).
 * Returns null when the entry has no valid usage.
 */
function extractEntryUsage(entry: Entry): EntryUsage | null {
    const usage =
        entry.type === "message"
            ? entry.message.role === "assistant"
                ? entry.message.usage
                : undefined
            : entry.type === "compaction" || entry.type === "branch_summary"
              ? entry.usage
              : undefined;
    if (
        !usage ||
        typeof usage.input !== "number" ||
        typeof usage.output !== "number" ||
        typeof usage.cacheRead !== "number" ||
        typeof usage.cacheWrite !== "number" ||
        typeof usage.cost?.total !== "number"
    ) {
        return null;
    }
    return usage;
}

/** Shared context-usage snapshot consumed by both controller and service. */
export interface ContextUsage {
    usedTokens: number;
    model: { contextWindow?: number; id?: string; provider?: string } | Model<Api> | undefined;
}

export interface ContextInfoServiceOptions {
    session: Session;
    lane: AgentLane;
}

export class ContextInfoService {
    private readonly session: Session;
    private readonly lane: AgentLane;

    constructor(opts: ContextInfoServiceOptions) {
        this.session = opts.session;
        this.lane = opts.lane;
    }

    /**
     * Current-session context-usage snapshot: the branch's context messages
     * run through `estimateContextTokens` (which anchors on the most recent
     * assistant usage where available and falls back to chars/4).
     *
     * The model is read off the lane — in pi 0.85 model selection is
     * per-lane configuration, not harness-wide.
     */
    async getContextUsage(): Promise<ContextUsage> {
        const messages = await buildBranchContext(this.session);
        const usedTokens = estimateContextTokens(messages).tokens;
        const model = await this.lane.getModel(harnessContext);
        return { usedTokens, model };
    }

    /**
     * Pulls current-session context info for the desktop status-bar indicator.
     *
     * - `usedTokens` comes from `estimateContextTokens` (per-turn heuristic for the progress bar).
     * - `lastCompactionAt` is read from the last `compaction` entry on the
     *   current branch and survives sidecar restarts.
     * - cache metric is the authoritative aggregate over the full tree.
     */
    async getContextInfo(): Promise<SessionContextInfoResult> {
        const { usedTokens, model } = await this.getContextUsage();
        const contextWindow = model?.contextWindow ?? 0;
        const ratio = contextWindow > 0 ? usedTokens / contextWindow : 0;
        const lastCompactionAt = await this.lastCompactionTimestamp();
        const cacheMetrics = await this.readCacheMetrics();
        return {
            modelId: model?.id ?? "",
            provider: String(model?.provider ?? ""),
            contextWindow,
            usedTokens,
            ratio,
            ...(lastCompactionAt ? { lastCompactionAt } : {}),
            ...cacheMetrics,
        };
    }

    /**
     * Read cache-hit metrics by walking `session.findEntries()`. Returns empty
     * object on a fresh session.
     * cacheRead = Σ usage.cacheRead; cacheHitRatio = Σ cacheRead / Σ (input + cacheRead).
     */
    private async readCacheMetrics(): Promise<{
        cacheRead?: number;
        cacheHitRatio?: number;
    }> {
        try {
            // Whole-log scan, not a branch walk: the cache aggregate is
            // authoritative over the full tree, including abandoned branches.
            const entries = await this.session.findEntries(undefined, harnessContext);
            let cacheRead = 0;
            let input = 0;
            for (const entry of entries) {
                const usage = extractEntryUsage(entry);
                if (!usage) continue;
                cacheRead += usage.cacheRead;
                input += usage.input;
            }
            const cacheable = input + cacheRead;
            if (cacheable === 0) {
                return {};
            }
            return {
                cacheRead,
                cacheHitRatio: cacheRead / cacheable,
            };
        } catch (e) {
            log.error("readCacheMetrics:", e);
            return {};
        }
    }

    /**
     * Timestamp of the most recent compaction entry on the current branch.
     *
     * Pushes the type filter and the "newest only" limit into the branch scan
     * rather than walking every entry — `BranchScan` already traverses the
     * parent chain newest-first, so pi stops at the first match.
     */
    private async lastCompactionTimestamp(): Promise<string | undefined> {
        try {
            const branch = await this.session.branch(MAIN_BRANCH, harnessContext);
            if (branch === undefined) return undefined;
            const entry = await branch.findEntry(
                { type: "compaction", order: "newestFirst" },
                harnessContext,
            );
            if (entry?.type === "compaction") return String(entry.timestamp);
        } catch (e) {
            log.error("lastCompactionTimestamp: branch scan failed:", e);
        }
        return undefined;
    }
}
