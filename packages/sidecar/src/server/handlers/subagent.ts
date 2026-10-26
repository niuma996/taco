/**
 * subagent.* handlers — control one running subagent independently of its
 * parent's turn.
 */

import type { SubagentAbortResult } from "@taco-ai/protocol";
import { registerMethod } from "../methodRegistry.ts";

export function registerSubagentHandlers(): void {
    registerMethod(
        "subagentAbort",
        true,
        async ({ workspace, params }) => {
            // Firing the child's controller is the whole job: the runner's
            // signal listener aborts the child harness, and the outcome
            // travels back through the normal settle path — the sync caller's
            // tool result, or the background run's `subagent.settled` +
            // notification with outcome "aborted".
            const stopped = workspace.agentSpawner.abortSubagentRun(params.subSessionId);
            return {
                status: stopped ? "aborted" : "not_running",
            } satisfies SubagentAbortResult;
        },
        { command: true },
    );
}
