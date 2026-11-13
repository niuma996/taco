/**
 * agents.* RPC handlers.
 *
 * agents.list    — return available agent types (built-in + user-defined)
 * agents.content — return a single agent's systemPrompt + metadata by agentType
 * agents.write   — create/edit one definition (global or workspace scope)
 * agents.delete  — remove one editable definition
 */

import { join } from "node:path";
import type {
    AgentsContentResult,
    AgentsDeleteResult,
    AgentsInstallRuntimeResult,
    AgentsListResult,
    AgentsRuntimeStatusResult,
    AgentsWriteResult,
} from "@taco-ai/protocol";
import { loadAgentDir } from "../../agents/loadAgents.ts";
import type { AgentDefinition } from "../../agents/types.ts";
import { createLogger } from "../../lib/logger.ts";
import { resourceRoot } from "../../runtime/runtimeResources.ts";
import type { ServerRpcSurface } from "../../runtime/serverRpcSurface.ts";
import {
    getCodexRuntimeStatus,
    installCodexRuntime,
} from "../../runtime/subagent/codex/codexRuntimeInstall.ts";
import type { WorkspaceRuntime } from "../../runtime/workspace.ts";
import { registerMethod } from "../methodRegistry.ts";
import {
    type AgentScopeContext,
    agentScopeOf,
    agentsDirFor,
    deleteUserAgent,
    readUserAgent,
    userAgentsDir,
    writeUserAgent,
} from "./agentsWrite.ts";

const log = createLogger("agents");

async function reloadAgents(server: ServerRpcSurface): Promise<void> {
    try {
        await server.reloadAgents?.();
    } catch (error) {
        log.warn("agent catalog hot reload failed", { error: String(error) });
    }
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
    registerMethod("agentsList", true, async ({ workspace, params }): Promise<AgentsListResult> => {
        const ctx = scopeContext(workspace);
        const scopedAgents =
            params.scope === "builtin"
                ? await loadAgentDir(join(resourceRoot(), "agents", "builtin"), "builtin")
                : params.scope === "global"
                  ? await loadAgentDir(userAgentsDir(), "user")
                  : params.scope === "workspace"
                    ? ctx.workspaceDir
                        ? await loadAgentDir(agentsDirFor("workspace", ctx), "user")
                        : []
                    : workspace.agents;
        const agents = scopedAgents.map((a: AgentDefinition) => {
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
    });

    registerMethod(
        "agentsContent",
        true,
        async ({ workspace, params }): Promise<AgentsContentResult> => {
            const def =
                params.scope === "builtin"
                    ? (
                          await loadAgentDir(join(resourceRoot(), "agents", "builtin"), "builtin")
                      ).find((agent) => agent.agentType === params.agentType)
                    : params.scope
                      ? await readUserAgent(params.agentType, params.scope, scopeContext(workspace))
                      : workspace.findAgent(params.agentType);
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
                timeoutMinutes: def.timeoutMinutes,
                ...(def.tools !== undefined ? { tools: def.tools } : {}),
                ...(def.permissionMode !== undefined ? { permissionMode: def.permissionMode } : {}),
                ...(def.runtime === "claude-code" && def.cwd !== undefined ? { cwd: def.cwd } : {}),
                ...(def.runtime === "codex" && def.codex !== undefined ? { codex: def.codex } : {}),
                source: def.source,
                ...(scope !== undefined ? { scope } : {}),
                editable: scope !== undefined,
            };
        },
    );

    registerMethod(
        "agentsWrite",
        true,
        async ({ server, workspace, params }): Promise<AgentsWriteResult> => {
            await writeUserAgent(params, workspace.agents, scopeContext(workspace));
            await reloadAgents(server);
            return { ok: true };
        },
    );

    registerMethod(
        "agentsDelete",
        true,
        async ({ server, workspace, params }): Promise<AgentsDeleteResult> => {
            await deleteUserAgent(
                params.agentType,
                workspace.agents,
                scopeContext(workspace),
                params.scope,
            );
            await reloadAgents(server);
            return { ok: true };
        },
    );

    /** Process-scoped Codex runtime status; never executes a paid model turn. */
    registerMethod(
        "agentsRuntimeStatus",
        false,
        async ({ params }): Promise<AgentsRuntimeStatusResult> => {
            void params.runtime;
            return getCodexRuntimeStatus();
        },
    );

    /** Process-scoped install of exactly the pinned managed Codex SDK. */
    registerMethod(
        "agentsInstallRuntime",
        false,
        async ({ params }): Promise<AgentsInstallRuntimeResult> => {
            void params.runtime;
            return installCodexRuntime();
        },
        { command: true },
    );
}
