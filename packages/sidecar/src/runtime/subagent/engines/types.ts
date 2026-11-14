import type { AgentSessionDescriptor, SessionId } from "@taco-ai/protocol";
import type { AgentChatArgs, AgentChatResult } from "../../../agents/agentConversationTypes.ts";
import type { AgentDefinition, SubagentRuntime } from "../../../agents/types.ts";
import type { AgentMessage } from "../../pi/types.ts";
import type { SessionRegistry } from "../../session/sessionRegistry.ts";
import type { ClaudeCodeInputHandle } from "../claudeCode/claudeCodeInput.ts";
import type { SubagentRunResult } from "../subagentRunner.ts";
import type { SubagentSessionArgs } from "../subagentTypes.ts";

export type EngineRunRequest = SubagentSessionArgs & {
    childSessionId: SessionId;
    abortController: AbortController;
};

export interface AgentEngine {
    readonly runtime: SubagentRuntime;
    readonly capabilities: {
        readonly forkContext: boolean;
        readonly delivery: "nativeQueue" | "nextTurn" | "afterRun";
        readonly workLane: boolean;
    };
    preflight(def: AgentDefinition): Promise<void>;
    run(args: EngineRunRequest): Promise<SubagentRunResult>;
}

export interface NativeEngineDeps {
    readonly registry: Pick<SessionRegistry, "withSession">;
    readonly executionCwd: () => string;
    readonly conversation: {
        setInput(id: SessionId, input: ClaudeCodeInputHandle): void;
        markRunning(id: SessionId, runId?: string): void;
        chat(callerSessionId: SessionId, args: AgentChatArgs): Promise<AgentChatResult>;
        list(callerSessionId: SessionId): Promise<AgentSessionDescriptor[]>;
    };
    /** Persist in order and push each message only after it has been appended. */
    readonly appendMessages: (childId: SessionId, messages: AgentMessage[]) => Promise<void>;
}
