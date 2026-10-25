/**
 * Harness-event wiring for `AttachedSession` — republishes the event types the
 * desktop consumes onto the session's "event" stream, then runs the
 * turn-boundary bookkeeping (close the checkpoint window, coordinate
 * incremental memory extraction, fire the once-per-attach title summary).
 *
 * Split out of `AttachedSession.create()` alongside `./hookWiring.ts`, which
 * does the same job for hooks: it is a self-contained subscriber set that reads
 * only the harness event bus, the session, and a handful of getters.
 */

import type { CheckpointManager } from "../../checkpoints/manager.ts";
import { createLogger } from "../../lib/logger.ts";
import type { TopicUsageTracker } from "../../memory/dream/usageTracker.ts";
import { type MemoryExtractor, sliceForExtraction } from "../../memory/index.ts";
import type { TacoToolContext } from "../../tools/context.ts";
import type { AgentHarness, AgentMessage, HarnessEvent, Session } from "../pi/types.ts";
import { buildBranchContext } from "../session/sessionBranch.ts";
import type { TitleSummarizer } from "../session/titleSummarizer.ts";

const log = createLogger("turnBookkeeping");

/**
 * Harness event types republished onto the session's "event" stream.
 *
 * pi 0.85 replaced the catch-all `harness.subscribe(cb)` with a typed
 * per-event bus, so the set of forwarded events is now explicit. These are the
 * types the desktop renders: streaming assistant output, tool-call lifecycle,
 * turn/run boundaries, queue depth, retry status and usage.
 *
 * Deliberately omitted: `handler_error` and `fault` (internal diagnostics that
 * are logged, not surfaced), `entry_added` (redundant with `message_*`),
 * `lane_created` / `value_update` / `config_update` (no UI), and the
 * `compaction_*` pair, which CompactionController republishes with its own
 * paired lifecycle signal so the push adapter's interlock stays intact.
 */
const REPUBLISHED_EVENTS = [
    "run_start",
    "run_end",
    "run_suspend",
    "run_resume",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_start",
    "tool_update",
    "tool_end",
    "queue_update",
    "retry_scheduled",
    "retry_start",
    "retry_end",
    "operation_abort",
    "navigation_start",
    "navigation_end",
    "usage",
] as const satisfies readonly HarnessEvent["type"][];

export interface TurnBookkeepingArgs {
    readonly harness: AgentHarness<TacoToolContext>;
    readonly session: Session;
    /** Forward a harness event onto the session's "event" stream. */
    readonly emitEvent: (event: HarnessEvent) => void;
    readonly getCheckpoints: () => CheckpointManager | undefined;
    readonly getExtractor: () => MemoryExtractor | undefined;
    readonly getTitleSummarizer: () => TitleSummarizer | undefined;
    /** Records successful `read`s of topic files; absent when memory is off. */
    readonly usageTracker?: TopicUsageTracker;
}

interface MemoryExtractionHandlerArgs {
    readonly buildContext: () => Promise<AgentMessage[]>;
    readonly getExtractor: () => MemoryExtractor | undefined;
}

/** Coordinate memory-tool offsets with one extraction per completed run. */
export function createMemoryExtractionHandlers(args: MemoryExtractionHandlerArgs): {
    onToolEnd(toolName: string, isError: boolean): void;
    onCompaction(): void;
    onRunEnd(status: "completed" | "aborted" | "failed"): void;
} {
    const { buildContext, getExtractor } = args;
    let pendingRememberCounts: Promise<number>[] = [];

    // An offset is a message count in the context at the time of the memory
    // call. Compaction rewrites the context, so a count from before it can be
    // past the new end and skip the whole run: drop the offsets and extract
    // over the compacted context instead. The extractor sees the existing
    // topics, so facts the model already saved come back as updates, not
    // duplicates.
    const onCompaction = (): void => {
        pendingRememberCounts = [];
    };

    const onToolEnd = (toolName: string, isError: boolean): void => {
        if (toolName !== "memory" || isError) return;
        // Capture synchronously so run_end sees the offset regardless of microtask
        // timing. A failed snapshot resolves to Infinity and extracts nothing.
        pendingRememberCounts.push(
            buildContext()
                .then((messages) => messages.length)
                .catch((error) => {
                    log.warn(
                        "context build failed during memory offset snapshot, skipping:",
                        error instanceof Error ? error.message : String(error),
                    );
                    return Number.POSITIVE_INFINITY;
                }),
        );
    };

    const onRunEnd = (status: "completed" | "aborted" | "failed"): void => {
        // Offsets never leak into the next run, including failed and disabled ones.
        const promises = pendingRememberCounts;
        pendingRememberCounts = [];
        if (status !== "completed") return;
        const extractor = getExtractor();
        if (extractor === undefined) return;

        buildContext()
            .then(async (contextMessages) => {
                let sinceCount: number | undefined;
                if (promises.length > 0) {
                    const counts = await Promise.all(promises);
                    sinceCount = Math.min(...counts);
                }
                const messages = sliceForExtraction(contextMessages, sinceCount);
                if (messages.length > 0) await extractor.onRunEnd(messages);
            })
            .catch((error) => {
                // Extraction is fire-and-forget and must not fail the run.
                log.warn(
                    "memory extraction after run_end failed:",
                    error instanceof Error ? error.message : String(error),
                );
            });
    };

    return { onToolEnd, onCompaction, onRunEnd };
}

/** Subscribe the republish + turn-boundary handlers; returns their disposers. */
export function wireTurnBookkeeping(args: TurnBookkeepingArgs): Array<() => void> {
    const { harness, session, emitEvent, getCheckpoints, getExtractor, getTitleSummarizer } = args;

    const republish = (event: HarnessEvent): void => {
        try {
            emitEvent(event);
        } catch (error) {
            // A downstream listener that throws must not abort this callback:
            // the checkpoint window close, memory extraction, and compaction
            // bookkeeping below still have to run. One bad subscriber never
            // starves the turn-boundary work.
            log.warn("event listener threw; continuing turn-boundary bookkeeping", {
                eventType: event.type,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const disposers: Array<() => void> = [];
    for (const type of REPUBLISHED_EVENTS) {
        disposers.push(harness.events.on(type, republish));
    }

    disposers.push(
        harness.events.on("turn_end", () => {
            // Memory extraction runs at run_end; checkpoint windows still close
            // after every model turn so the next write opens a fresh restore point.
            getCheckpoints()?.endTurn();
        }),
    );

    const memoryHandlers = createMemoryExtractionHandlers({
        buildContext: () => buildBranchContext(session),
        getExtractor,
    });
    // `read` args arrive on tool_start; only a successful tool_end counts as use.
    const pendingReads = new Map<string, unknown>();
    const { usageTracker } = args;
    disposers.push(
        harness.events.on("tool_start", (event) => {
            if (usageTracker && event.toolName === "read") {
                pendingReads.set(event.toolCallId, (event.args as { path?: unknown } | null)?.path);
            }
        }),
        harness.events.on("tool_end", (event) => {
            memoryHandlers.onToolEnd(event.toolName, event.isError);
            if (pendingReads.has(event.toolCallId)) {
                const path = pendingReads.get(event.toolCallId);
                pendingReads.delete(event.toolCallId);
                if (!event.isError) usageTracker?.noteRead(path);
            }
        }),
        harness.events.on("compaction_end", () => {
            memoryHandlers.onCompaction();
        }),
        harness.events.on("run_end", (event) => {
            memoryHandlers.onRunEnd(event.status);
        }),
    );

    // Title summarization — re-runs on every completed run_end so the title
    // tracks where the conversation actually went, not just its opening
    // message. A user rename still wins permanently (setSummaryTitle refuses
    // to overwrite titleSource "user").
    //
    // The guard is concurrency, not frequency: a summary's LLM call can still
    // be in flight when the next turn ends, and two overlapping writes would
    // race to set the name. Skipping while one is running drops the redundant
    // attempt — the next run_end re-summarizes over a context that already
    // includes the skipped turn.
    let summarizing = false;
    disposers.push(
        harness.events.on("run_end", (event) => {
            if (summarizing || event.status !== "completed") return;
            const summarizer = getTitleSummarizer();
            if (summarizer === undefined) return;
            summarizing = true;
            buildBranchContext(session)
                .then((messages) => summarizer.onRunEnd(messages))
                .catch((error) => {
                    // The context build itself failing must never surface as an
                    // unhandled rejection on this fire-and-forget chain.
                    // TitleSummarizer.onRunEnd already catches its own errors.
                    log.warn(
                        "title summarization after run_end failed:",
                        error instanceof Error ? error.message : String(error),
                    );
                })
                .finally(() => {
                    summarizing = false;
                });
        }),
    );

    // Flush batched usage on detach so a closed session's reads are not lost.
    if (usageTracker) disposers.push(() => usageTracker.flush());

    return disposers;
}
