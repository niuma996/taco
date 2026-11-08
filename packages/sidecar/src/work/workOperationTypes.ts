import type { AgentMessage } from "@taco-ai/protocol";

/** Execution identity is independent of the conversation opened by the overview. */
export interface WorkOperationRef {
    readonly workspace: string;
    readonly sessionId: string;
    readonly lane: string;
    readonly operationId: string;
}

export interface WorkAttemptHandle {
    readonly workId: string;
    readonly attemptId: string;
}

export interface WorkAnswerContext {
    readonly operationId: string;
    readonly attempt?: WorkAttemptHandle;
    bind(handle: WorkAttemptHandle): Promise<void>;
    readPartial?(): Promise<string>;
}

export type WorkOperationObservation =
    | { kind: "open" }
    | { kind: "missing" }
    | { kind: "unknown" }
    | {
          kind: "settled";
          outcome: "completed" | "error" | "aborted";
          message?: AgentMessage;
          reason?: string;
      };

export interface WorkOperationRuntime {
    inspect(ref: WorkOperationRef): Promise<WorkOperationObservation>;
    abort(
        ref: WorkOperationRef,
    ): Promise<{ outcome: "accepted" | "mismatch" | "deferred"; newlyRequested: boolean }>;
}
