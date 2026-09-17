/**
 * Run an attached subagent to completion and report its result.
 *
 * Split out of `AgentSpawner` because it is a self-contained sequence over one
 * already-attached session: the turn cap is local state, and the only thing it
 * needs from the spawner is a way to read the child's last assistant text.
 */

import type { AgentToolDetails, SessionId } from "@taco-ai/protocol";
import type { SubagentProgressSink } from "../../agents/types.ts";
import type { AttachedSession } from "../harness/attachedSession.ts";
import type { AgentToolResult, HarnessEvent } from "../pi/types.ts";
import { subagentStartedResult, subagentTurnResult } from "./subagentProgress.ts";

export interface RunAttachedSubagentArgs {
    readonly subSessionId: SessionId;
    readonly attached: AttachedSession;
    readonly prompt: string;
    /** Metadata agentType / event agentType (must be consistent). Labels progress updates. */
    readonly agentType: string;
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
): Promise<{ subSessionId: SessionId; resultText: string; isError: boolean }> {
    const { subSessionId, attached, agentType, readLastAssistantText } = args;
    const onUpdate = args.onUpdate;
    // Single point where this runner asserts its payload shape onto the sink:
    // the sink is typed over `never` so every tool callback is assignable to it
    // (see SubagentProgressSink), which leaves the payload assertion here.
    const publish = (
        payload: AgentToolResult<AgentToolDetails>,
        options?: { checkpoint: true },
    ): void => {
        onUpdate?.(payload as AgentToolResult<never>, options);
    };

    // Publish the recovery handle before the child does any work: if the process
    // dies mid-run, pi folds this checkpoint's content into the interrupted tool
    // result, and that session id is what lets the model resume instead of
    // re-spawning. See subagentProgress.ts.
    publish(subagentStartedResult({ subSessionId, agentType }), { checkpoint: true });

    // The turn cap is enforced here rather than by the harness, which takes
    // no turn limit: count completed turns and abort on the cap. Whatever
    // the child produced up to that point is still returned below, so a
    // capped run degrades to a partial answer instead of an error.
    const cap = args.maxTurns !== undefined && args.maxTurns > 0 ? args.maxTurns : undefined;
    let turnsUsed = 0;
    let hitCap = false;
    let acceptingUpdates = true;
    let progressSeq = 0;
    const onTurnEnd = (event: HarnessEvent): void => {
        if (event.type !== "turn_end") return;
        turnsUsed++;
        if (cap !== undefined && turnsUsed >= cap && !hitCap) {
            hitCap = true;
            void attached.abort();
        }
        if (!onUpdate) return;
        // Reading the child's branch is async; drop the result if a newer turn
        // already published, or if the run settled while the read was in flight.
        const seq = ++progressSeq;
        void readLastAssistantText(subSessionId)
            .then(({ text }) => {
                if (!acceptingUpdates || seq !== progressSeq) return;
                publish(
                    subagentTurnResult({
                        subSessionId,
                        agentType,
                        turns: turnsUsed,
                        lastText: text,
                    }),
                );
            })
            .catch(() => {
                // Progress is best-effort; the run's own result path reports failures.
            });
    };
    attached.on("event", onTurnEnd);

    try {
        await attached.prompt(args.prompt);
    } catch (e) {
        // hitCap before signal.aborted: keep partial answer instead of discarding it.
        if (hitCap) {
            const { text } = await readLastAssistantText(subSessionId);
            return {
                subSessionId,
                resultText: partialResult(text, cap ?? turnsUsed),
                isError: false,
            };
        }
        if (args.signal?.aborted) {
            return { subSessionId, resultText: "(aborted)", isError: true };
        }
        return {
            subSessionId,
            resultText: e instanceof Error ? e.message : String(e),
            isError: true,
        };
    } finally {
        acceptingUpdates = false;
        attached.off("event", onTurnEnd);
    }

    // Extract last assistant text. An empty reply is a failure, not a
    // success whose text happens to be the literal string below.
    const { text, isEmpty } = await readLastAssistantText(subSessionId);
    if (isEmpty) {
        return {
            subSessionId,
            resultText: "subagent returned an empty response",
            isError: true,
        };
    }
    return { subSessionId, resultText: text, isError: false };
}

/**
 * Label a turn-capped run so the caller can tell a finished answer from a
 * truncated one. Returned as a success: the work done so far is still usable.
 */
function partialResult(text: string, cap: number): string {
    const prefix = `[partial: stopped after reaching the ${cap}-turn limit]`;
    return text === ""
        ? `${prefix} subagent produced no answer before the limit.`
        : `${prefix}\n${text}`;
}
