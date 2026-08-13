/**
 * session_before_compact hook — pin-aware compression. Without this, `compression=pin`
 * tags are silently lost. Pipeline: extract+strip pin segments → inject directive →
 * call pi's compact() → layer in file ops, facts, pin tail. Each step is guarded.
 */

import {
    type AgentMessage,
    type CompactionPreparation,
    type CompactResult,
    compact,
    DEFAULT_COMPACTION_SETTINGS,
    prepareCompaction,
    type SessionBeforeCompactResult,
    type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { createLogger } from "../../lib/logger.ts";
import { extractAndStripPinned } from "../extractors.ts";
import { EMPTY_FACTS, extractFacts, type FactSet, mergeFacts } from "../factExtractor.ts";
import { tagRegistry } from "../registry.ts";
import type { PinnedSegment } from "../types.ts";
import { buildPinnedDirective, buildPinnedTail } from "./compression.ts";
import { extractExtendedFileOps } from "./extendedFileOps.ts";

const log = createLogger("taco:pin-aware-compact");

/** Persisted details shape on a CompactionEntry. Extends pi's `details`. */
export interface PinAwareCompactionDetails {
    readonly facts: FactSet;
    readonly readFiles: string[];
    readonly modifiedFiles: string[];
    /** pinOnce instanceIds consumed in this compaction — prevents re-injection. */
    readonly consumedPinOnceInstances: readonly string[];
}

/** Read a string[] field from pi's loose-typed `details`, falling back to [].
 *  pi-agent-core types `CompactResult.details` as `unknown`; the helpers below
 *  apply the same `readFiles` / `modifiedFiles` shape on top. */
function detailList(details: unknown, key: "readFiles" | "modifiedFiles"): string[] {
    const v = (details as { [k: string]: unknown } | undefined)?.[key];
    return Array.isArray(v) ? v : [];
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Return only the messages that have a string or block-array `content`
 *  field, filtering custom variants gracefully. */
function collectTextMessages(prep: CompactionPreparation): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const m of prep.messagesToSummarize) {
        const c = (m as { content?: unknown }).content;
        if (typeof c === "string" || Array.isArray(c)) out.push(m);
    }
    for (const m of prep.turnPrefixMessages) {
        const c = (m as { content?: unknown }).content;
        if (typeof c === "string" || Array.isArray(c)) out.push(m);
    }
    return out;
}

/** Build a fresh preparation with `messagesToSummarize` augmented by a
 *  preamble user message — used to inject the pin directive. We clone only
 *  the field we change; everything else passes through. */
function withPrefaceDirective(
    prep: CompactionPreparation,
    directive: string,
): CompactionPreparation {
    const preface: AgentMessage = {
        role: "user",
        content: directive,
        timestamp: Date.now(),
    } as AgentMessage;
    return {
        ...prep,
        messagesToSummarize: [preface, ...prep.messagesToSummarize],
    };
}

/** Merge two sorted-preferred lists, dedup keeping first occurrence. */
function uniqueMerge(a: string[], b: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of a) {
        if (!seen.has(x)) {
            seen.add(x);
            out.push(x);
        }
    }
    for (const x of b) {
        if (!seen.has(x)) {
            seen.add(x);
            out.push(x);
        }
    }
    return out;
}

/** Pull existing facts out of the previous compaction's `details`, if any. */
function factsFromDetails(details: unknown): FactSet {
    if (!details || typeof details !== "object") return EMPTY_FACTS;
    const f = (details as { facts?: unknown }).facts;
    if (!f || typeof f !== "object") return EMPTY_FACTS;
    const o = f as Partial<FactSet>;
    return {
        decisions: Array.isArray(o.decisions) ? (o.decisions as FactSet["decisions"]) : [],
        constraints: Array.isArray(o.constraints) ? (o.constraints as FactSet["constraints"]) : [],
        entities: Array.isArray(o.entities) ? (o.entities as FactSet["entities"]) : [],
    };
}

// ─── pin extraction over a preparation ──────────────────────────────────────

interface PinExtraction {
    readonly pinned: PinnedSegment[];
    readonly stripped: CompactionPreparation;
}

function applyPinExtraction(prep: CompactionPreparation): PinExtraction {
    // extractAndStripPinned's `M extends { content: unknown }` constraint
    // excludes non-text `AgentMessage` variants (e.g. `BashExecutionMessage`);
    // we cast through unknown and narrow via `collectTextMessages` for steps
    // that need a content field.
    const main = extractAndStripPinned(
        prep.messagesToSummarize as unknown as Array<{
            content: unknown;
        }>,
    );
    const prefix = extractAndStripPinned(
        prep.turnPrefixMessages as unknown as Array<{
            content: unknown;
        }>,
    );
    const pinned = [...main.pinned, ...prefix.pinned];
    return {
        pinned,
        stripped: {
            ...prep,
            messagesToSummarize: main.strippedMessages as unknown as AgentMessage[],
            turnPrefixMessages: prefix.strippedMessages as unknown as AgentMessage[],
        },
    };
}

// ─── hook factory ───────────────────────────────────────────────────────────

export interface PinAwareCompactHookOptions {
    readonly models: Models;
    /** Lazy model lookup — mirrors `buildStripThinkingContextHook`'s pattern. */
    // biome-ignore lint/suspicious/noExplicitAny: pi-agent-core AgentHarness.getModel() returns Model<any>.
    readonly getModel: () => Model<any>;
    /**
     * Live read of the current compaction threshold (same source as
     * AttachedSession.effectiveCompaction). Used to recompute
     * keepRecentTokens — see recomputePreparation below.
     */
    readonly getThreshold: () => number;
}

/**
 * Recompute the compaction cut-point. `harness.compact()` uses a hard-coded
 * `keepRecentTokens=20000` disconnected from the trigger threshold, causing
 * ineffective re-trigger when near/below 20000. Re-run with threshold-scaled
 * keepRecentTokens = floor(contextWindow × threshold × 0.5). Returns null on
 * failure so caller falls back to pi's preparation.
 */
function recomputePreparation(
    branchEntries: readonly SessionTreeEntry[],
    contextWindow: number,
    threshold: number,
): CompactionPreparation | null {
    if (!contextWindow || contextWindow <= 0) return null;
    const keepRecentTokens = Math.max(1, Math.floor(contextWindow * threshold * 0.5));
    const settings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        enabled: true,
        keepRecentTokens,
    };
    const result = prepareCompaction([...branchEntries], settings);
    if (!result.ok || !result.value) return null;
    return result.value;
}

export function buildPinAwareCompactHook(
    opts: PinAwareCompactHookOptions,
): (event: {
    preparation: CompactionPreparation;
    branchEntries?: SessionTreeEntry[];
    signal: AbortSignal;
}) => Promise<SessionBeforeCompactResult | undefined> {
    return async (event) => {
        try {
            const { branchEntries, signal } = event;
            const model = opts.getModel();

            // 0. Recompute the cut-point: pi's preparation uses a hard-coded
            //    keepRecentTokens=20000, which barely compresses at low thresholds.
            //    Re-derive keepRecentTokens from the threshold and override.
            //    Falls back to the original preparation if branchEntries is
            //    missing (shouldn't happen) or recompute fails.
            const contextWindow = model?.contextWindow ?? 0;
            const recomputed = branchEntries
                ? recomputePreparation(branchEntries, contextWindow, opts.getThreshold())
                : null;
            const preparation = recomputed ?? event.preparation;

            // 1+2. Extract pin content from both message pools; strip from text.
            const { pinned, stripped } = applyPinExtraction(preparation);

            // 3. Inject directive (only when there's something to protect).
            const directive = buildPinnedDirective(pinned.map((p) => String(p.name)));
            const prepForCompact = directive ? withPrefaceDirective(stripped, directive) : stripped;

            // 4. Reuse pi's default compaction (seven-section summary + fileOps).
            //    customInstructions / thinkingLevel left undefined — pin directive is
            //    already injected via withPrefaceDirective above, so the default
            //    summary path runs unchanged.
            const compactRes = await compact(
                prepForCompact,
                opts.models,
                model,
                undefined,
                signal,
                undefined,
            );
            if (!compactRes.ok) {
                log.error("pi compact() failed:", compactRes.error);
                return undefined; // fall back to harness default
            }
            const base = compactRes.value;

            // 4a. Extended file ops from non-canonical tools.
            // 4b. Structured facts from one extra LLM call (best-effort).
            // 4c. Merge with previous compaction's facts (by key).
            // 4d. Pin tail appended verbatim to the summary text.
            // 4e. Record consumed pinOnce instanceIds so context hooks can skip re-injection.
            const textMessages = collectTextMessages(preparation);
            const extended = extractExtendedFileOps(textMessages);
            const freshFacts = await extractFacts(textMessages, opts.models, model, { signal });
            const priorFacts = factsFromDetails(base.details);
            const mergedFacts = mergeFacts(priorFacts, freshFacts);
            const tail = buildPinnedTail(pinned);

            // Collect pinOnce instanceIds — deduplicated across both message pools.
            const consumedPinOnceInstances = pinned
                .filter(
                    (p) =>
                        (tagRegistry[p.name]?.compression as { kind: string }).kind === "pinOnce",
                )
                .map((p) => p.instanceId);

            const details: PinAwareCompactionDetails = {
                facts: mergedFacts,
                readFiles: uniqueMerge(
                    detailList(base.details, "readFiles"),
                    extended.extraReadFiles,
                ),
                modifiedFiles: uniqueMerge(
                    detailList(base.details, "modifiedFiles"),
                    extended.extraModifiedFiles,
                ),
                consumedPinOnceInstances,
            };

            const compaction: CompactResult = {
                summary: base.summary + tail,
                firstKeptEntryId: base.firstKeptEntryId,
                tokensBefore: base.tokensBefore,
                details,
            };
            return { compaction };
        } catch (err) {
            log.error("hook threw, falling back:", err);
            return undefined;
        }
    };
}
