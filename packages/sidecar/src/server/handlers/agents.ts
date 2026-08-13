/**
 * agents.* RPC handlers.
 *
 * agents.list    — return available agent types (built-in + user-defined)
 * agents.content — return a single agent's systemPrompt + metadata by agentType
 */

import type {
    AgentEntry,
    AgentsContentParams,
    AgentsContentResult,
    AgentsListParams,
    AgentsListResult,
} from "@taco-ai/protocol";
import { agentsContentSchema, agentsListSchema } from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import type { AgentDefinition } from "../../agents/types.ts";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";

export function registerAgentsHandlers(): void {
    registerMethod(
        RPC.agentsList,
        true,
        async ({ workspace }: MethodCtx<AgentsListParams>): Promise<AgentsListResult> => {
            const agents: AgentEntry[] = workspace.agents.map((a: AgentDefinition) => ({
                agentType: a.agentType,
                description: a.description,
                whenToUse: a.whenToUse,
                source: a.source,
            }));
            return { agents };
        },
        { schema: agentsListSchema },
    );

    registerMethod(
        RPC.agentsContent,
        true,
        async ({
            workspace,
            params,
        }: MethodCtx<AgentsContentParams>): Promise<AgentsContentResult> => {
            const def = workspace.findAgent(params.agentType);
            if (!def) {
                throw new Error(`agent not found: ${params.agentType}`);
            }
            return {
                agentType: def.agentType,
                systemPrompt: def.systemPrompt,
                description: def.description,
                whenToUse: def.whenToUse,
                source: def.source,
            };
        },
        { schema: agentsContentSchema },
    );
}
