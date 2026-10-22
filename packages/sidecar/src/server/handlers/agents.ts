/**
 * agents.* RPC handlers.
 *
 * agents.list    — return available agent types (built-in + user-defined)
 * agents.content — return a single agent's systemPrompt + metadata by agentType
 * agents.write   — create/edit one definition (global or workspace scope)
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
import { createLogger } from "../../lib/logger.ts";
import type { ServerRpcSurface } from "../../runtime/serverRpcSurface.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import { type MethodCtx, registerMethod } from "../methodRegistry.ts";
import type { ServerRegistry } from "../serverRegistry.ts";
import {
    type AgentScopeContext,
    agentScopeOf,
    deleteUserAgent,
    writeUserAgent,
} from "./agentsWrite.ts";

const log = createLogger("agents");

async function reloadAgentsEverywhere(
    server: ServerRpcSurface,
    serverRegistry: ServerRegistry | undefined,
): Promise<void> {
    const targets = serverRegistry?.all() ?? [server];
    await Promise.all(
        targets.map(async (target) => {
            try {
                await target.reloadAgents?.();
            } catch (error) {
                log.warn("agent catalog hot reload failed", { error: String(error) });
            }
        }),
    );
}

/**
 * The project directory a workspace-scoped definition lives under: the one the
 * catalog was scanned from (`executionCwd`, see `reloadAgents`). IM
 * conversations have none — their cwd is a scratch directory, not a project.
 */
function scopeContext(workspace: WorkspaceRuntime): AgentScopeContext {
    const allowedCwds = [workspace.executionCwd, ...workspace.associatedRoots()];
    return workspace.imRouting !== undefined
        ? { allowedCwds }
        : { workspaceDir: workspace.executionCwd, allowedCwds };
}

export function registerAgentsHandlers(): void {
    registerMethod(
        RPC.agentsList,
        true,
        async ({ workspace }: MethodCtx<AgentsListParams>): Promise<AgentsListResult> => {
            const ctx = scopeContext(workspace);
            const agents = workspace.agents.map((a: AgentDefinition) => {
                const scope = agentScopeOf(a, ctx);
                return {
                    agentType: a.agentType,
                    description: a.description,
                    whenToUse: a.whenToUse,
                    context: a.context,
                    runtime: a.runtime,
                    source: a.source,
                    ...(scope !== undefined ? { scope } : {}),
                    editable: scope !== undefined,
                };
            });
            return { agents, cwdChoices: [...(ctx.allowedCwds ?? [])] };
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
            const scope = agentScopeOf(def, scopeContext(workspace));
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
                ...(def.runtime === "claude-code" && def.cwd !== undefined ? { cwd: def.cwd } : {}),
                source: def.source,
                ...(scope !== undefined ? { scope } : {}),
                editable: scope !== undefined,
            };
        },
        { schema: agentsContentSchema },
    );

    registerMethod(
        RPC.agentsWrite,
        true,
        async ({
            server,
            serverRegistry,
            workspace,
            params,
        }: MethodCtx<AgentsWriteParams>): Promise<AgentsWriteResult> => {
            await writeUserAgent(params, workspace.agents, scopeContext(workspace));
            await reloadAgentsEverywhere(server, serverRegistry);
            return { ok: true };
        },
        { schema: agentsWriteSchema },
    );

    registerMethod(
        RPC.agentsDelete,
        true,
        async ({
            server,
            serverRegistry,
            workspace,
            params,
        }: MethodCtx<AgentsDeleteParams>): Promise<AgentsDeleteResult> => {
            await deleteUserAgent(params.agentType, workspace.agents, scopeContext(workspace));
            await reloadAgentsEverywhere(server, serverRegistry);
            return { ok: true };
        },
        { schema: agentsDeleteSchema },
    );
}
