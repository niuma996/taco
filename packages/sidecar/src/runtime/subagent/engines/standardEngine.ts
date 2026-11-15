import type { SessionId } from "@taco-ai/protocol";
import type { AttachedSession } from "../../harness/attachedSession.ts";
import type { SessionRegistry } from "../../session/sessionRegistry.ts";
import { type ChildAttachDeps, prepareChildAttach } from "../childAttach.ts";
import { runAttachedSubagent } from "../subagentRunner.ts";
import { subagentStartupFailure } from "../subagentStartupFailure.ts";
import type { AgentEngine, EngineRunRequest } from "./types.ts";

interface StandardEngineDeps {
    registry: SessionRegistry;
    childAttachDeps(): ChildAttachDeps;
    defaultModelIdentity(): string | undefined;
    readLastAssistantText(id: SessionId): Promise<{ text: string; isEmpty: boolean }>;
}

/** Standard sessions own their harness; native engines keep separate state. */
export function createStandardEngine(deps: StandardEngineDeps): AgentEngine {
    return {
        runtime: "standard",
        capabilities: { forkContext: true, delivery: "nativeQueue", workLane: true },
        preflight: async () => {},
        async run(args: EngineRunRequest) {
            const childDepth = args.childDepth;
            if (childDepth === undefined)
                throw new Error("executeSubagentSession: childDepth must be provided by caller");
            let prepared: Awaited<ReturnType<typeof prepareChildAttach>>;
            try {
                prepared = await prepareChildAttach(deps.childAttachDeps(), {
                    sessionId: args.childSessionId,
                    agentType: args.agentType,
                    childDepth,
                    allowedTools: args.tools,
                    toolPolicy: args.toolPolicy,
                    rolePrompt: args.rolePrompt,
                    fewShots: args.fewShots,
                    forkedContext: args.forkedContext,
                    modelIdentity: args.model
                        ? `${args.model.provider}/${args.model.id}`
                        : deps.defaultModelIdentity(),
                });
            } catch (error) {
                return subagentStartupFailure(args, "prepare_attach", error);
            }
            let attached: AttachedSession;
            try {
                attached = await deps.registry.attachChild(
                    args.childSessionId,
                    {
                        thinkingLevel: "off",
                        model: args.model,
                        toolLoadPolicy: args.toolPolicy,
                        getSubagentBudget: args.budget ? () => args.budget : undefined,
                    },
                    prepared.tools,
                    prepared.taskState,
                    prepared.systemPrompt,
                );
            } catch (error) {
                return subagentStartupFailure(args, "attach", error);
            }
            return runAttachedSubagent({
                subSessionId: args.childSessionId,
                attached,
                prompt: args.prompt,
                agentType: args.agentType,
                maxTurns: args.maxTurns,
                budget: args.budget,
                signal: args.abortController.signal,
                onUpdate: args.onUpdate,
                resumability: args.resumability,
                readLastAssistantText: deps.readLastAssistantText,
            });
        },
    };
}
