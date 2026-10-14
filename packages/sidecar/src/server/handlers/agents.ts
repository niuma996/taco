/**
 * agents.* RPC handlers.
 *
 * agents.list    — return available agent types (built-in + user-defined)
 * agents.content — return a single agent's systemPrompt + metadata by agentType
 * agents.write   — create/edit one definition under $TACO_HOME/agents
 * agents.delete  — remove one editable definition
 */

import type {
    AgentsContentParams,
    AgentsContentResult,
    AgentsDeleteParams,
    AgentsDeleteResult,
    AgentsListParams,
    AgentsListResult,
    AgentsWriteParams,
    AgentsWriteResult,
} from "@taco-ai/protocol";
import {
    agentsContentSchema,
    agentsDeleteSchema,
    agentsListSchema,
    agentsWriteSchema,
} from "@taco-ai/protocol";
import { RPC } from "@taco-ai/shared";
import type { AgentDefinition } from "../../agents/types.ts";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";
import { deleteUserAgent, isEditableAgent, writeUserAgent } from "./agentsWrite.ts";

export function registerAgentsHandlers(): void {
    registerMethod(
        RPC.agentsList,
        true,
        async ({ workspace }: MethodCtx<AgentsListParams>): Promise<AgentsListResult> => {
            const agents = workspace.agents.map((a: AgentDefinition) => ({
                agentType: a.agentType,
                description: a.description,
                whenToUse: a.whenToUse,
                context: a.context,
                runtime: a.runtime,
                source: a.source,
                editable: isEditableAgent(a),
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
                context: def.context,
                runtime: def.runtime,
                maxTurns: def.maxTurns,
                ...(def.tools !== undefined ? { tools: def.tools } : {}),
                ...(def.permissionMode !== undefined ? { permissionMode: def.permissionMode } : {}),
                source: def.source,
                editable: isEditableAgent(def),
            };
        },
        { schema: agentsContentSchema },
    );

    registerMethod(
        RPC.agentsWrite,
        true,
        async ({
            server,
            workspace,
            params,
        }: MethodCtx<AgentsWriteParams>): Promise<AgentsWriteResult> => {
            await writeUserAgent(params, workspace.agents);
            if (server.reloadAgents) await server.reloadAgents();
            return { ok: true };
        },
        { schema: agentsWriteSchema },
    );

    registerMethod(
        RPC.agentsDelete,
        true,
        async ({
            server,
            workspace,
            params,
        }: MethodCtx<AgentsDeleteParams>): Promise<AgentsDeleteResult> => {
            await deleteUserAgent(params.agentType, workspace.agents);
            if (server.reloadAgents) await server.reloadAgents();
            return { ok: true };
        },
        { schema: agentsDeleteSchema },
    );
}
