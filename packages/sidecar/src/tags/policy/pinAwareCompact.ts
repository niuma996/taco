/**
 * session_before_compact hook — pin-aware compression. Without this, `compression=pin`
 * tags are silently lost. Pipeline: extract+strip pin segments → pi compact() with
 * pin instructions on `customInstructions` → extended file ops + verbatim pin tail.
 * One LLM call. Throws fall back to the harness default path.
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
import { compact as defaultCompact } from "../../runtime/pi/values.ts";
import { extractAndStripPinned } from "../extractors.ts";
import { tagRegistry } from "../registry.ts";
import type { PinnedSegment } from "../types.ts";
import { buildPinnedTail, mergeCompactionInstructions } from "./compression.ts";
import { extractExtendedFileOps } from "./extendedFileOps.ts";

const log = createLogger("taco:pin-aware-compact");

/** Persisted details shape on a CompactionEntry. Extends pi's `details`. */
export interface PinAwareCompactionDetails {
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
     * handling, which is the whole reason this hook exists.
     */
    readonly getRetryPolicy: () => Promise<RetryPolicy>;
    /**
     * Summarization entry. Production uses pi's `compact`; tests inject a
     * stub so the `customInstructions` merge can be asserted without a
     * provider round-trip.
     */
    readonly compact?: typeof defaultCompact;
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

            // Extract pin content from both message pools; strip from text so
            // the summarizer does not paraphrase bodies that will be appended.
            const { pinned, stripped } = applyPinExtraction(preparation);

            // Pin handling rides on pi's `customInstructions` (`Additional
            // focus:`), not a conversation preface — the latter is serialized
            // as session content. Auto-compact and manual RPC share this path.
            const customInstructions = mergeCompactionInstructions(
                event.customInstructions,
                pinned.map((p) => String(p.name)),
            );

            // Reuse pi's default compaction (seven-section summary + fileOps).
            // thinkingLevel left undefined — pin handling is in
            // customInstructions, so the default summary path runs unchanged.
            // A retry-policy read failure is tolerated rather than fatal:
            // losing resilience is better than losing pin handling.
            const retry: RetryPolicy | undefined = await opts
                .getRetryPolicy()
                .catch(() => undefined);
            const runCompact = opts.compact ?? defaultCompact;
            const compactRes = await runCompact(
                stripped,
                opts.models,
                model,
                customInstructions,
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

            const textMessages = collectTextMessages(preparation);
            const extended = extractExtendedFileOps(textMessages);
            const tail = buildPinnedTail(pinned);

            const consumedPinOnceInstances = pinned
                .filter(
                    (p) =>
                        (tagRegistry[p.name]?.compression as { kind: string }).kind === "pinOnce",
                )
                .map((p) => p.instanceId);

            const details: PinAwareCompactionDetails = {
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
