import type { SessionId } from "@taco-ai/protocol";
import type { AgentDefinition } from "../../agents/types.ts";
import type { ResumeSubagentArgs } from "./subagentResume.ts";
import type { SubagentRunResult } from "./subagentRunner.ts";
import type { SubagentSessionArgs } from "./subagentTypes.ts";

export type SubagentOutcome = "completed" | "error" | "aborted";

/** Execution services expose runs without exposing facade bookkeeping. */
export interface SubagentExecution {
    execute(args: SubagentSessionArgs): Promise<SubagentRunResult>;
    resume(args: ResumeSubagentArgs): Promise<SubagentRunResult>;
    track<T>(
        parentSessionId: SessionId,
        parentToolCallId: string,
        run: () => Promise<T>,
    ): Promise<T>;
}

export interface SubagentEvents {
    emit(event: string, payload: unknown): void;
    /** Returns true only when this is a conversation continuation owned by the event sink. */
    settleChat(runId: string, outcome: SubagentOutcome): boolean;
}

export interface SubagentChatStarted {
    parentSessionId: SessionId;
    parentToolCallId: string;
    subSessionId: SessionId;
    agentType: string;
    runId: string;
    messageId: string;
}

export interface SubagentChatEvents {
    announce(started: SubagentChatStarted): void;
    settle(runId: string, outcome: SubagentOutcome): void;
}

export interface BackgroundSubagentLauncher {
    reserve(parentToolCallId: string): "duplicate" | "full" | undefined;
    release(parentToolCallId: string): void;
    launch(
        args: SubagentSessionArgs,
        definition: AgentDefinition,
        description?: string,
    ): Promise<{
        subSessionId: SessionId;
        resultText: string;
        isError: boolean;
        background: true;
        resultPath: string;
    }>;
}
