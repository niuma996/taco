/**
 * The `memory.dream` built-in job handler: consolidate every workspace that
 * passes its gate, at most MAX_WORKSPACES_PER_RUN per fire.
 *
 * Process-level on purpose. Memory lives in `projects/<hash>/`, one dir per
 * workspace, and the hash is one-way — the job walks the dirs directly and
 * opens each with `LocalMemoryStore.openByKey`. That store is a different
 * instance from any live session's, so in-process write ordering cannot be
 * relied on: the dream lock plus compare-and-swap writes are what keep a
 * concurrent extractor or UI edit from being clobbered.
 */

import { readGlobalConfig } from "../../config/config.ts";
import { createLogger } from "../../lib/logger.ts";
import type { ProviderKeyStore } from "../../runtime/models/providerKeyStore.ts";
import type { Api, Model, Models } from "../../runtime/pi/types.ts";
import { parseMemoryDreamArgs } from "../../scheduler/builtinJobs.ts";
import type { BuiltinJobHandler } from "../../scheduler/dispatcher.ts";
import { LocalMemoryStore } from "../local/store.ts";
import { type DreamOutcome, runDream } from "./consolidator.ts";
import { resolveDreamModel } from "./dreamModel.ts";
import type { DreamOptions } from "./dreamPlan.ts";
import { readLastDreamAt } from "./dreamState.ts";

const log = createLogger("memory:dream-job");

/**
 * Workspaces consolidated per fire. Each costs one LLM call, and the
 * scheduler times a fire out after five minutes; the rest wait for the next
 * fire (or the boot catch-up), oldest-consolidated first.
 */
export const MAX_WORKSPACES_PER_RUN = 5;

export interface DreamJobDeps {
    /** `false` when `memoryEnabled` is off: every fire is then a no-op. */
    readonly memoryEnabled: () => boolean;
    /** Resolve the model for consolidation; `override` is the job's args.model. */
    readonly resolveModel: (override?: string) => { models: Models; model: Model<Api> } | undefined;
    /** Directory keys to consider; defaults to every dir under `projects/`. */
    readonly listDirKeys?: () => string[];
}

export interface DreamJobRun {
    readonly force?: boolean;
    readonly options?: Partial<DreamOptions>;
    readonly model?: string;
}

/** Per-workspace outcomes plus the history line. */
export interface DreamJobResult {
    readonly summary: string;
    readonly outcomes: ReadonlyArray<{ readonly dirKey: string; readonly outcome: DreamOutcome }>;
}

export async function runDreamJob(
    deps: DreamJobDeps,
    run: DreamJobRun = {},
): Promise<DreamJobResult> {
    if (!deps.memoryEnabled()) return { summary: "skipped: memory is disabled", outcomes: [] };
    const resolved = deps.resolveModel(run.model);
    if (!resolved) throw new Error("no model available for memory consolidation");

    // Least recently consolidated first, so a backlog drains fairly.
    const keys = (deps.listDirKeys ?? LocalMemoryStore.listDirKeys)()
        .map((dirKey) => ({ dirKey, store: LocalMemoryStore.openByKey(dirKey) }))
        .sort((a, b) => readLastDreamAt(a.store.topicDir) - readLastDreamAt(b.store.topicDir));

    const outcomes: Array<{ dirKey: string; outcome: DreamOutcome }> = [];
    let acted = 0;
    for (const { dirKey, store } of keys) {
        if (acted >= MAX_WORKSPACES_PER_RUN) break;
        const outcome = await runDream(
            { store, models: resolved.models, model: resolved.model },
            { force: run.force, options: run.options },
        );
        outcomes.push({ dirKey, outcome });
        // Gate skips are free; only runs that reached the model count toward the cap.
        if (outcome.status !== "skipped") acted++;
        if (outcome.status === "failed") log.warn(`dream ${dirKey}: ${outcome.reason}`);
    }
    const summary = summarize(outcomes);
    // Every model call failing is a broken run (no key, provider down), not a
    // quiet night: throw so history shows an error and the breaker can trip.
    const failures = outcomes.filter((o) => o.outcome.status === "failed");
    if (acted > 0 && failures.length === acted) {
        const first = failures[0]?.outcome;
        throw new Error(`${summary}: ${first?.status === "failed" ? first.reason : "unknown"}`);
    }
    return { summary, outcomes };
}

function summarize(outcomes: ReadonlyArray<{ outcome: DreamOutcome }>): string {
    let applied = 0;
    let previewed = 0;
    let failed = 0;
    let merged = 0;
    let mergedInto = 0;
    let archived = 0;
    let rewritten = 0;
    for (const { outcome } of outcomes) {
        if (outcome.status === "applied") {
            applied++;
            merged += outcome.report.counts.merged;
            mergedInto += outcome.report.counts.mergedInto;
            archived += outcome.report.counts.archived;
            rewritten += outcome.report.counts.rewritten;
        } else if (outcome.status === "previewed") {
            previewed++;
        } else if (outcome.status === "failed") {
            failed++;
        }
    }
    if (applied + previewed + failed === 0) return "no workspace needed consolidation";
    const parts: string[] = [];
    if (applied > 0) {
        parts.push(
            `${applied} consolidated (merged ${merged}→${mergedInto}, archived ${archived}, rewrote ${rewritten})`,
        );
    }
    if (previewed > 0) parts.push(`${previewed} preview awaiting review`);
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.join("; ");
}

/**
 * The scheduler handler for the built-in `memory.dream` job. Reads the live
 * global config each fire, so turning memory off or changing the default
 * model in Settings takes effect on the next run.
 */
export function createMemoryDreamHandler(keys: ProviderKeyStore): BuiltinJobHandler {
    return async (job) => {
        const parsed = parseMemoryDreamArgs(job.args);
        if (!parsed.ok) throw new Error(parsed.error);
        const { model, ...options } = parsed.args;
        const result = await runDreamJob(
            {
                memoryEnabled: () => readGlobalConfig().memoryEnabled !== false,
                resolveModel: (override) => resolveDreamModel(keys, override),
            },
            { options, model },
        );
        return { summary: result.summary };
    };
}
