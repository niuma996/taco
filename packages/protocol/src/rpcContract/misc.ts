/**
 * RPC contract rows — tools / agents / skills / mcp — the remaining read and configuration methods.
 *
 * Three tables move together: the wire name, the params/result types, and the
 * params schema. `rpcContract/index.ts` merges them into the single
 * `RPC` / `rpcContract` / `rpcSchemas` exports that the client and the
 * sidecar both read.
 *
 * Adding a method to this domain means adding one entry to each of the three
 * tables below — the compile-time assertions in the index catch a row that
 * was added to one and forgotten in another.
 */

import type {
    McpCreateConfigParams,
    McpDeleteConfigParams,
    McpDeleteConfigResult,
    McpGetConfigParams,
    McpGetConfigResult,
    McpListServersParams,
    McpListServersResult,
    McpMutateConfigResult,
    McpUpdateConfigParams,
} from "../config.js";
import {
    agentsContentSchema,
    agentsDeleteSchema,
    agentsListSchema,
    agentsWriteSchema,
    mcpCreateConfigSchema,
    mcpDeleteConfigSchema,
    mcpGetConfigSchema,
    mcpListServersSchema,
    mcpUpdateConfigSchema,
    skillContentSchema,
    skillsListSchema,
    toolsListSchema,
} from "../schemas/index.js";
import type {
    AgentsContentParams,
    AgentsContentResult,
    AgentsDeleteParams,
    AgentsDeleteResult,
    AgentsListParams,
    AgentsListResult,
    AgentsWriteParams,
    AgentsWriteResult,
    SkillContentParams,
    SkillContentResult,
    SkillsListParams,
    SkillsListResult,
    ToolsListParams,
    ToolsListResult,
} from "../tools.js";
import type { RpcContractRow } from "./types.js";

/** Wire names for this domain. */
export const miscMethods = {
    toolsList: "tools.list",
    // agents.*
    agentsList: "agents.list",
    agentsContent: "agents.content",
    agentsWrite: "agents.write",
    agentsDelete: "agents.delete",
    skillsList: "skills.list",
    skillContent: "skills.content",
    // checkpoints.* — pre-write file snapshots; restore is client-driven only.
    mcpListServers: "mcp.listServers",
    mcpGetConfig: "mcp.getConfig",
    mcpCreateConfig: "mcp.createConfig",
    mcpUpdateConfig: "mcp.updateConfig",
    mcpDeleteConfig: "mcp.deleteConfig",
    // ── jobs.* ──
} as const;

/** Params/result types and routing scope for this domain. */
export const miscContract = {
    toolsList: { scope: "workspace" } as RpcContractRow<ToolsListParams, ToolsListResult>,
    agentsList: { scope: "workspace" } as RpcContractRow<AgentsListParams, AgentsListResult>,
    agentsContent: { scope: "workspace" } as RpcContractRow<
        AgentsContentParams,
        AgentsContentResult
    >,
    agentsWrite: { scope: "workspace" } as RpcContractRow<AgentsWriteParams, AgentsWriteResult>,
    agentsDelete: { scope: "workspace" } as RpcContractRow<AgentsDeleteParams, AgentsDeleteResult>,
    skillsList: { scope: "workspace" } as RpcContractRow<SkillsListParams, SkillsListResult>,
    skillContent: { scope: "workspace" } as RpcContractRow<SkillContentParams, SkillContentResult>,
    mcpListServers: { scope: "process" } as RpcContractRow<
        McpListServersParams,
        McpListServersResult
    >,
    mcpGetConfig: { scope: "process" } as RpcContractRow<McpGetConfigParams, McpGetConfigResult>,
    mcpCreateConfig: { scope: "process" } as RpcContractRow<
        McpCreateConfigParams,
        McpMutateConfigResult
    >,
    mcpUpdateConfig: { scope: "process" } as RpcContractRow<
        McpUpdateConfigParams,
        McpMutateConfigResult
    >,
    mcpDeleteConfig: { scope: "process" } as RpcContractRow<
        McpDeleteConfigParams,
        McpDeleteConfigResult
    >,
    // ── jobs.* ──
};

/** Params schemas for this domain. */
export const miscSchemas = {
    toolsList: toolsListSchema,
    agentsList: agentsListSchema,
    agentsContent: agentsContentSchema,
    agentsWrite: agentsWriteSchema,
    agentsDelete: agentsDeleteSchema,
    skillsList: skillsListSchema,
    skillContent: skillContentSchema,
    mcpListServers: mcpListServersSchema,
    mcpGetConfig: mcpGetConfigSchema,
    mcpCreateConfig: mcpCreateConfigSchema,
    mcpUpdateConfig: mcpUpdateConfigSchema,
    mcpDeleteConfig: mcpDeleteConfigSchema,
};
