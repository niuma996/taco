import type { AgentChatArgs, AgentChatResult } from "../../agents/agentConversationTypes.ts";
import type { AgentDefinition, SubagentRuntime } from "../../agents/types.ts";
import { uuidv7 } from "../pi/values.ts";
import { readSessionFacts } from "../session/sessionFacts.ts";
import type { SessionRegistry } from "../session/sessionRegistry.ts";
import type { AgentMessageRecord } from "./agentConversation.ts";
import { agentMessageEnvelope } from "./agentConversation.ts";
import { type AgentConversationRuntime, hasAgentNativeState } from "./agentConversationRuntime.ts";
import { normalizeSubagentRuntime, sameSubagentRuntime } from "./engines/runtime.ts";
import type { AgentEngine } from "./engines/types.ts";
import type {
    BackgroundSubagentLauncher,
    SubagentChatEvents,
    SubagentExecution,
} from "./subagentCoordination.ts";
import type { SubagentRunLifecycle } from "./subagentRunLifecycle.ts";

export interface AgentConversationRunnerOptions {
    readonly sessionRegistry: SessionRegistry;
    readonly conversation: AgentConversationRuntime;
    readonly engines: Record<SubagentRuntime, AgentEngine>;
    readonly background: BackgroundSubagentLauncher;
    readonly runLifecycle: SubagentRunLifecycle;
    readonly execution: Pick<SubagentExecution, "resume" | "track">;
    readonly findAgent: (type: string) => AgentDefinition | undefined;
    readonly events: SubagentChatEvents;
}

export class AgentConversationRunner {
    constructor(private readonly options: AgentConversationRunnerOptions) {}

    async start(message: AgentMessageRecord, args: AgentChatArgs) {
        const facts = await this.options.sessionRegistry.withSession(
            message.targetSessionId,
            readSessionFacts,
        );
        const def = facts.agentType ? this.options.findAgent(facts.agentType) : undefined;
        if (!def)
            throw new Error(
                "The original agent profile is unavailable; create a new agent explicitly.",
            );
        if (!sameSubagentRuntime(facts.runtime, def.runtime)) {
            throw new Error(
                "The agent profile changed execution engine; the existing conversation cannot switch engines.",
            );
        }
        if (
            !(await hasAgentNativeState(
                this.options.sessionRegistry,
                message.targetSessionId,
                facts.runtime,
            ))
        ) {
            throw new Error(
                normalizeSubagentRuntime(facts.runtime) === "codex"
                    ? "This Codex session cannot be resumed because its native thread mapping was not saved. Create a fresh agent explicitly."
                    : "This Claude Code session cannot be resumed because it has no saved native session. Create a fresh agent explicitly.",
            );
        }
        if (normalizeSubagentRuntime(facts.runtime) === "codex") {
            await this.options.engines.codex.preflight(def);
        }
        const runId = uuidv7();
        const started = {
            parentSessionId: message.ownerParentSessionId,
            parentToolCallId: facts.parentToolCallId ?? args.parentToolCallId,
            subSessionId: message.targetSessionId,
            agentType: def.agentType,
            runId,
            messageId: message.messageId,
        };
        const announce = () => {
            this.options.events.announce(started);
        };
        const prompt = message.queueEntryId
            ? `Process the queued agent message ${message.messageId}. Its content is in the native message queue.`
            : agentMessageEnvelope(message);
        const delivery =
            this.options.engines[normalizeSubagentRuntime(facts.runtime)].capabilities.delivery;
        const receipt: AgentChatResult = {
            subSessionId: message.targetSessionId,
            messageId: message.messageId,
            runId,
            status: "started",
            effectiveDelivery:
                delivery === "afterRun"
                    ? "followUp"
                    : delivery === "nextTurn"
                      ? "nextTurn"
                      : message.delivery,
            resultText:
                "The existing agent conversation is continuing. Completion will be reported to its original parent.",
            isError: false,
        };
        if (message.background) {
            const parentToolCallId = `chat:${runId}`;
            if (this.options.background.reserve(parentToolCallId) !== undefined)
                throw new Error("Too many background subagents already running.");
            try {
                announce();
                const launched = await this.options.background.launch(
                    {
                        parentSessionId: message.ownerParentSessionId,
                        parentToolCallId,
                        childSessionId: message.targetSessionId,
                        executionId: runId,
                        resume: true,
                        agentType: def.agentType,
                        prompt,
                        tools: [],
                        runtime: facts.runtime,
                        budget: {
                            turnsUsed: 0,
                            startedAt: Date.now(),
                            ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
                        },
                    },
                    def,
                    message.prompt.slice(0, 160),
                );
                return { result: { ...receipt, resultPath: launched.resultPath } };
            } catch (error) {
                this.options.background.release(parentToolCallId);
                this.options.events.settle(runId, "error");
                throw error;
            }
        }
        const executionScope = this.options.runLifecycle.acquire({
            sessionId: message.targetSessionId,
            parentSessionId: message.ownerParentSessionId,
            signal: args.signal,
        });
        const executionController = executionScope.controller;
        try {
            announce();
            this.options.conversation.begin(message.targetSessionId, {
                runId,
                parentSessionId: message.ownerParentSessionId,
                runtime: facts.runtime,
                phase: "preparing",
            });
        } catch (error) {
            executionScope.release();
            this.options.events.settle(runId, "error");
            throw error;
        }
        const completion = this.options.execution
            .track(message.ownerParentSessionId, args.parentToolCallId, () =>
                this.options.execution.resume({
                    parentSessionId: message.ownerParentSessionId,
                    parentToolCallId: args.parentToolCallId,
                    subSessionId: message.targetSessionId,
                    prompt,
                    signal: args.signal,
                    onUpdate: args.onUpdate,
                    newTask: true,
                    managedExternally: true,
                    executionId: runId,
                    abortController: executionController,
                }),
            )
            .then(
                async (result) => {
                    this.options.events.settle(
                        runId,
                        result.aborted ? "aborted" : result.isError ? "error" : "completed",
                    );
                    await this.options.conversation.end(message.targetSessionId, runId, result);
                    return {
                        ...receipt,
                        status: result.aborted
                            ? ("aborted" as const)
                            : result.isError
                              ? ("error" as const)
                              : ("completed" as const),
                        resultText: result.resultText,
                        isError: result.isError && !result.aborted,
                    };
                },
                async (error: unknown) => {
                    const result = {
                        subSessionId: message.targetSessionId,
                        resultText: String(error),
                        isError: true,
                    };
                    this.options.events.settle(runId, "error");
                    await this.options.conversation.end(message.targetSessionId, runId, result);
                    return {
                        ...receipt,
                        status: "error" as const,
                        resultText: String(error),
                        isError: true,
                    };
                },
            )
            .finally(() => {
                executionScope.release();
            });
        return { result: receipt, completion };
    }
}
