/**
 * ContextInfoService — session context-usage queries + context-info assembly.
 *
 * cacheHitRatio = ΣcacheRead / Σ(input + cacheRead).
 * Denominator excludes `cacheWrite` (first-turn prefix is unavoidable) and
 * `output` (pi compaction uses `cacheRetention: "none"`; summary would dilute the
 * ratio). `getSessionStats()` only exposes merged `uncachedTokens = Σ(input +
 * cacheWrite)`, so we walk `session.getEntries()` ourselves for one-pass
 * accumulation.
 */

import {
    type AgentHarness,
    type ExecutionToolContext,
    estimateContextTokens,
    type Session,
    type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { SessionContextInfoResult } from "@taco-ai/protocol";
import { createLogger } from "../lib/logger.ts";

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
function extractEntryUsage(entry: SessionTreeEntry): EntryUsage | null {
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
    model: ReturnType<AgentHarness<ExecutionToolContext>["getModel"]>;
}

export interface ContextInfoServiceOptions {
    session: Session;
    harness: AgentHarness<ExecutionToolContext>;
}

export class ContextInfoService {
    private readonly session: Session;
    private readonly harness: AgentHarness<ExecutionToolContext>;

    constructor(opts: ContextInfoServiceOptions) {
        this.session = opts.session;
        this.harness = opts.harness;
    }

    /**
     * Current-session context-usage snapshot. Calls `session.buildContext()`
     * to get messages, then `estimateContextTokens` (anchors on the most
     * recent assistant usage where possible, falls back to chars/4).
     */
    async getContextUsage(): Promise<ContextUsage> {
        const ctx = await this.session.buildContext();
        const usedTokens = estimateContextTokens(ctx.messages).tokens;
        const model = this.harness.getModel();
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
     * Read cache-hit metrics by walking `session.getEntries()`. Returns empty
     * object on a fresh session.
     * cacheRead = Σ usage.cacheRead; cacheHitRatio = Σ cacheRead / Σ (input + cacheRead).
     */
    private async readCacheMetrics(): Promise<{
        cacheRead?: number;
        cacheHitRatio?: number;
    }> {
        try {
            const entries = await this.session.getEntries();
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

    /** Walks the current branch from the leaf backward, returning the most recent compaction entry's timestamp. */
    private async lastCompactionTimestamp(): Promise<string | undefined> {
        try {
            const entries = await this.session.getBranch();
            for (let i = entries.length - 1; i >= 0; i--) {
                const e = entries[i] as SessionTreeEntry | undefined;
                if (e?.type === "compaction") return e.timestamp;
            }
        } catch (e) {
            log.error("lastCompactionTimestamp: getBranch failed:", e);
        }
        return undefined;
    }
}
