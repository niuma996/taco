import type { SessionId } from "@taco-ai/protocol";
import { createLogger } from "../../lib/logger.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";

const log = createLogger("sidecar.subagent");

/** Startup can fail with a persisted child but without ever submitting its prompt. */
export function subagentStartupFailure(
    args: { childSessionId: SessionId; parentSessionId: SessionId; parentToolCallId: string },
    failurePhase: NonNullable<SubagentRunResult["failurePhase"]>,
    error: unknown,
): SubagentRunResult {
    log.child({
        subSessionId: args.childSessionId,
        parentSessionId: args.parentSessionId,
        parentToolCallId: args.parentToolCallId,
        failurePhase,
    }).error("subagent startup failed", error);
    const detail = error instanceof Error ? error.message : String(error);
    return {
        subSessionId: args.childSessionId,
        isError: true,
        failurePhase,
        resultText: `Subagent startup failed during ${failurePhase}, before this attempt submitted a prompt to the child: ${detail}`,
    };
}
