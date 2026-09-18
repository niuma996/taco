/**
 * session_before_compact hook — pin-aware compression. Without this, `compression=pin`
 * tags are silently lost. Pipeline: extract+strip pin segments → inject directive →
 * call pi's compact() → layer in file ops, facts, pin tail. Each step is guarded.
 *
 * Retention is NOT decided here. It comes from the shared `CompactionSettings`
 * that `CompactionController.syncSettings()` pushes onto the harness, so this
 * hook cuts where pi's turn-boundary check cuts.
 */

import { harnessContext } from "../../lib/harnessContext.ts";
import { createLogger } from "../../lib/logger.ts";
import type {
    AgentMessage,
    CompactionPreparation,
    CompactResult,
    JsonValue,
    Model,
    Models,
    RetryPolicy,
} from "../../runtime/pi/types.ts";
import { compact } from "../../runtime/pi/values.ts";
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
    /**
     * Lazy model lookup. Async because pi 0.85 reads the model off the lane;
     * resolves to `undefined` when the lane has no model configured, in which
     * case the hook declines and pi's default compaction runs.
     */
    // biome-ignore lint/suspicious/noExplicitAny: pi's Model is generic over its Api.
    readonly getModel: () => Promise<Model<any> | undefined>;
    /**
     * Retry policy for the summarization call. pi's own path retries with the
     * lane's policy, so the hook must match it: without retries here, a single
     * transient provider error makes this hook return `undefined`, and pi then
     * regenerates the summary on its default path — silently without the pin
     * directive, which is the whole reason this hook exists.
     */
    readonly getRetryPolicy: () => Promise<RetryPolicy>;
}

export function buildPinAwareCompactHook(
    opts: PinAwareCompactHookOptions,
): (event: {
    preparation: CompactionPreparation;
    customInstructions?: string;
}) => Promise<{ compaction: CompactResult } | undefined> {
    return async (event) => {
        try {
            const model = await opts.getModel();
            if (model === undefined) {
                // No model on the lane — decline and let pi's default path run.
                return undefined;
            }

            // pi's preparation already reflects the shared settings, so the
            // cut-point is taken as-is rather than recomputed.
            const preparation = event.preparation;

            // 1+2. Extract pin content from both message pools; strip from text.
            const { pinned, stripped } = applyPinExtraction(preparation);

            // 3. Inject directive (only when there's something to protect).
            const directive = buildPinnedDirective(pinned.map((p) => String(p.name)));
            const prepForCompact = directive ? withPrefaceDirective(stripped, directive) : stripped;

            // 4. Reuse pi's default compaction (seven-section summary + fileOps).
            //    thinkingLevel left undefined — the pin directive is already
            //    injected via withPrefaceDirective above, so the default summary
            //    path runs unchanged. Cancellation rides on the context.
            //    A retry-policy read failure is tolerated rather than fatal:
            //    losing resilience is better than losing pin handling.
            const retry: RetryPolicy | undefined = await opts
                .getRetryPolicy()
                .catch(() => undefined);
            const compactRes = await compact(
                prepForCompact,
                opts.models,
                model,
                event.customInstructions,
                undefined,
                retry,
                undefined,
                harnessContext,
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
            const freshFacts = await extractFacts(textMessages, opts.models, model, {});
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
                tokensBefore: base.tokensBefore,
                // `details` is structurally JSON but declared with readonly
                // arrays, which `JsonValue` does not accept. pi only persists
                // it, so the cast is safe.
                details: details as unknown as JsonValue,
                // Carry pi's retained tail through unchanged. These are the
                // recent messages kept verbatim after the cut point; dropping
                // them would silently delete the tail of the conversation.
                retainedTail: base.retainedTail,
                ...(base.usage === undefined ? {} : { usage: base.usage }),
            };
            return { compaction };
        } catch (err) {
            log.error("hook threw, falling back:", err);
            return undefined;
        }
    };
}
