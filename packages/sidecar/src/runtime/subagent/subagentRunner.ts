/**
 * Run an attached subagent to completion and report its result.
 *
 * Split out of `AgentSpawner` because it is a self-contained sequence over one
 * already-attached session: the turn cap is local state, and the only thing it
 * needs from the spawner is a way to read the child's last assistant text.
 *
 * `readLastAssistantText` is used only on the settle paths (final answer, or the
 * partial answer left by a capped run). Per-turn progress reads the assistant
 * message off the `turn_end` event instead, so a running subagent adds no
 * session reads.
 */

import type { SessionId, SubagentProgressDetails } from "@taco-ai/protocol";
import type { SubagentProgressSink } from "../../agents/types.ts";
import type { AttachedSession } from "../harness/attachedSession.ts";
import type { AgentToolResult, HarnessEvent } from "../pi/types.ts";
import {
    assistantText,
    failedResult,
    neutralizeControlTags,
    partialResult,
    SUBAGENT_STOPPED_TEXT,
    type SubagentResumability,
    subagentStartedResult,
    subagentTurnResult,
} from "./subagentProgress.ts";

export interface RunAttachedSubagentArgs {
    readonly subSessionId: SessionId;
    readonly attached: AttachedSession;
    readonly prompt: string;
    /** Metadata agentType / event agentType (must be consistent). Labels progress updates. */
    readonly agentType: string;
    /**
     * Whether `agentContinue` can resume this child. Drives what the durable
     * checkpoint tells the model to do after an interruption; see
     * SubagentResumability. Defaults to `not_resumable` so a new caller has to
     * opt in rather than inherit guidance that may not hold for it.
     */
    readonly resumability?: SubagentResumability;
    /**
     * The **remaining** turn budget for this run — callers are responsible for
     * subtracting already-consumed turns. Enforced by counting `turn_end` and
     * aborting, because `AgentHarnessOptions` exposes no turn limit.
     */
    readonly maxTurns?: number;
    readonly signal?: AbortSignal;
    /**
     * Streaming-update sink. The started update is checkpointed so an
     * interrupted call leaves the child's session id in the transcript; turn
     * updates are live-only.
     */
    readonly onUpdate?: SubagentProgressSink;
    /** Read the child's current branch for its last assistant text. */
    readonly readLastAssistantText: (
        subSessionId: SessionId,
    ) => Promise<{ text: string; isEmpty: boolean }>;
}

/**
 * Run prompt on an already-attached child harness and extract the final text.
 * Shared by a fresh spawn (after attach) and a resume (after re-attaching to a
 * pre-existing session).
 *
 * Never throws — every failure is reported as `{ isError: true }`, and a run
 * that hit the turn cap degrades to a partial answer rather than an error.
 */
export async function runAttachedSubagent(
    args: RunAttachedSubagentArgs,
): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean; aborted?: boolean }> {
    const { subSessionId, attached, agentType, readLastAssistantText } = args;
    const onUpdate = args.onUpdate;
    // Single point where this runner asserts its payload shape onto the sink:
    // the sink is typed over `never` so every tool callback is assignable to it
    // (see SubagentProgressSink), which leaves the payload assertion here.
    const publish = (
        payload: AgentToolResult<SubagentProgressDetails>,
        options?: { checkpoint: true },
    ): void => {
        onUpdate?.(payload as AgentToolResult<never>, options);
    };

    // Publish the recovery handle before the child does any work: if the process
    // dies mid-run, pi folds this checkpoint's content into the interrupted tool
    // result, and that session id is what lets the model resume instead of
    // re-spawning. See subagentProgress.ts.
    publish(
        subagentStartedResult({
            subSessionId,
            agentType,
            resumability: args.resumability ?? "not_resumable",
        }),
        { checkpoint: true },
    );

    // The turn cap is enforced here rather than by the harness, which takes
    // no turn limit: count completed turns and abort on the cap. Whatever
    // the child produced up to that point is still returned below, so a
    // capped run degrades to a partial answer instead of an error.
    const cap = args.maxTurns !== undefined && args.maxTurns > 0 ? args.maxTurns : undefined;
    let turnsUsed = 0;
    let lastTurnText: string | undefined;
    let hitCap = false;
    let acceptingUpdates = true;
    const onTurnEnd = (event: HarnessEvent): void => {
        if (event.type !== "turn_end") return;
        turnsUsed++;
        // The failing turn is usually an empty error message; keep the last
        // turn that actually said something.
        const turnText = assistantText(event.message);
        if (turnText.trim() !== "") lastTurnText = turnText;
        if (cap !== undefined && turnsUsed >= cap && !hitCap) {
            hitCap = true;
            void attached.abort();
        }
        if (!onUpdate || !acceptingUpdates) return;
        // Progress text comes off the event itself, not off disk: `turn_end`
        // already carries the assistant message that just completed, so this
        // stays synchronous — no per-turn branch read, and no ordering window
        // in which a slow read could publish after a newer turn or after the
        // run settled.
        publish(
            subagentTurnResult({
                subSessionId,
                agentType,
                turns: turnsUsed,
                lastText: turnText,
            }),
        );
    };
    attached.on("event", onTurnEnd);

    // Propagate cancellation into the child harness. `args.signal?.aborted`
    // below only covers a signal that fired before the prompt; without this
    // listener nothing tells the child to stop, and pi's abort awaits this
    // tool's execute() — so a parent abort (or a background run's own
    // timeout controller) could not actually stop a running subagent.
    const onAbortSignal = (): void => {
        void attached.abort();
    };
    args.signal?.addEventListener("abort", onAbortSignal, { once: true });

    try {
        await attached.prompt(args.prompt);
    } catch (e) {
        // hitCap before signal.aborted: keep partial answer instead of discarding it.
        if (hitCap) {
            const { text: rawText } = await readLastAssistantText(subSessionId);
            // The child's own text reaches the parent verbatim from here — scrub
            // any control-tag shape it might contain before it does (see
            // subagentProgress.ts's neutralizeControlTags for why).
            const { text } = neutralizeControlTags(rawText);
            return {
                subSessionId,
                resultText: partialResult(text, cap ?? turnsUsed),
                isError: false,
            };
        }
        if (args.signal?.aborted) {
            return {
                subSessionId,
                resultText: SUBAGENT_STOPPED_TEXT,
                isError: true,
                aborted: true,
            };
        }
        return {
            subSessionId,
            resultText: failedResult({
                error: e instanceof Error ? e.message : String(e),
                subSessionId,
                turns: turnsUsed,
                lastText: lastTurnText,
                resumability: args.resumability ?? "not_resumable",
            }),
            isError: true,
        };
    } finally {
        acceptingUpdates = false;
        attached.off("event", onTurnEnd);
        args.signal?.removeEventListener("abort", onAbortSignal);
    }

    // Extract last assistant text. An empty reply is a failure, not a
    // success whose text happens to be the literal string below.
    const { text: rawText, isEmpty } = await readLastAssistantText(subSessionId);
    if (isEmpty) {
        return {
            subSessionId,
            resultText: "subagent returned an empty response",
            isError: true,
        };
    }
    // Scrub before this reaches the parent — same reasoning as the
    // partial-cap branch above.
    const { text } = neutralizeControlTags(rawText);
    return { subSessionId, resultText: text, isError: false };
}
