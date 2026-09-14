/**
 * Run an attached subagent to completion and report its result.
 *
 * Split out of `AgentSpawner` because it is a self-contained sequence over one
 * already-attached session: the turn cap is local state, and the only thing it
 * needs from the spawner is a way to read the child's last assistant text.
 */

import type { SessionId } from "@taco-ai/protocol";
import type { AttachedSession } from "../harness/attachedSession.ts";
import type { HarnessEvent } from "../pi/types.ts";

export interface RunAttachedSubagentArgs {
    readonly subSessionId: SessionId;
    readonly attached: AttachedSession;
    readonly prompt: string;
    /**
     * The **remaining** turn budget for this run — callers are responsible for
     * subtracting already-consumed turns. Enforced by counting `turn_end` and
     * aborting, because `AgentHarnessOptions` exposes no turn limit.
     */
    readonly maxTurns?: number;
    readonly signal?: AbortSignal;
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
    const { subSessionId, attached, readLastAssistantText } = args;

    // The turn cap is enforced here rather than by the harness, which takes
    // no turn limit: count completed turns and abort on the cap. Whatever
    // the child produced up to that point is still returned below, so a
    // capped run degrades to a partial answer instead of an error.
    const cap = args.maxTurns !== undefined && args.maxTurns > 0 ? args.maxTurns : undefined;
    let turnsUsed = 0;
    let hitCap = false;
    const onTurnEnd = (event: HarnessEvent): void => {
        if (event.type !== "turn_end" || cap === undefined) return;
        turnsUsed++;
        if (turnsUsed >= cap && !hitCap) {
            hitCap = true;
            void attached.abort();
        }
    };
    if (cap !== undefined) attached.on("event", onTurnEnd);

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
        if (cap !== undefined) attached.off("event", onTurnEnd);
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
