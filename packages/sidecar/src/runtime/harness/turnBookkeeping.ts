/**
 * Harness-event wiring for `AttachedSession` — republishes the event types the
 * desktop consumes onto the session's "event" stream, then runs the
 * turn-boundary bookkeeping (close the checkpoint window, coordinate
 * incremental memory extraction).
 *
 * Split out of `AttachedSession.create()` alongside `./hookWiring.ts`, which
 * does the same job for hooks: it is a self-contained subscriber set that reads
 * only the harness event bus, the session, and two getters.
 */

import type { CheckpointManager } from "../../checkpoints/manager.ts";
import { createLogger } from "../../lib/logger.ts";
import { type MemoryExtractorImpl, sliceForExtraction } from "../../memory/index.ts";
import type { TacoToolContext } from "../../tools/context.ts";
import type { AgentHarness, HarnessEvent, Session } from "../pi/types.ts";
import { buildBranchContext } from "../session/sessionBranch.ts";

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
    readonly getExtractor: () => MemoryExtractorImpl | undefined;
}

/** Subscribe the republish + turn-boundary handlers; returns their disposers. */
export function wireTurnBookkeeping(args: TurnBookkeepingArgs): Array<() => void> {
    const { harness, session, emitEvent, getCheckpoints, getExtractor } = args;

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

    // Memory extraction — coordinator across two events:
    //   tool_end ("memory") → pushes a Promise<number> resolving to the
    //     context message count right after the commit.
    //   turn_end → takes ownership of all pending Promises (resets the
    //     array synchronously), then awaits their min offset. This handles
    //     multiple memory calls in the same turn — instead of overwriting,
    //     we take the earliest offset so only messages BEFORE all memory
    //     calls are sent to the extractor.
    //
    // Closure-local rather than a field on AttachedSession: turn_end's take-and-reset
    // is the only writer, so keeping the array here makes that structural.
    let pendingRememberCounts: Promise<number>[] = [];

    disposers.push(
        harness.events.on("tool_end", (event) => {
            if (event.toolName !== "memory" || event.isError) return;
            // Push synchronously so turn_end's Promise.all sees it regardless of
            // microtask timing; the rejection is absorbed here (Infinity never wins
            // Math.min), so a context-build failure can't become an unhandled
            // rejection nor poison the offset computation.
            pendingRememberCounts.push(
                buildBranchContext(session)
                    .then((messages) => messages.length)
                    .catch((error) => {
                        log.warn(
                            "context build failed during memory offset snapshot, skipping:",
                            error instanceof Error ? error.message : String(error),
                        );
                        return Number.POSITIVE_INFINITY;
                    }),
            );
        }),
    );

    disposers.push(
        harness.events.on("turn_end", () => {
            // Close the checkpoint window so the next turn's first write opens
            // a fresh restore point instead of folding into this turn's.
            getCheckpoints()?.endTurn();

            const extractor = getExtractor();
            if (extractor === undefined) return;
            // Synchronous take + reset — after this line, no other code
            // path writes to pendingRememberCounts.
            const promises = pendingRememberCounts;
            pendingRememberCounts = [];
            buildBranchContext(session)
                .then(async (contextMessages) => {
                    let sinceCount: number | undefined;
                    if (promises.length > 0) {
                        try {
                            const counts = await Promise.all(promises);
                            sinceCount = Math.min(...counts);
                        } catch {
                            // extractor failure must never bleed into the
                            // turn — fall back to "no offset" semantics
                            sinceCount = undefined;
                        }
                    }
                    const messages = sliceForExtraction(contextMessages, sinceCount);
                    if (messages.length > 0) {
                        await extractor.onTurnEnd(messages);
                    }
                })
                .catch((error) => {
                    // The context build or the extractor rejecting must never
                    // surface as an unhandled rejection on this fire-and-forget chain.
                    log.warn(
                        "memory extraction after turn_end failed:",
                        error instanceof Error ? error.message : String(error),
                    );
                });
        }),
    );

    return disposers;
}
