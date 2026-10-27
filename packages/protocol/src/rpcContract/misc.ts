/**
 * RPC contract rows — tools / agents / skills / mcp — the remaining read and configuration methods.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
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
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const miscRows = {
    toolsList: row<ToolsListParams, ToolsListResult>()("tools.list", "workspace", toolsListSchema),
    agentsList: row<AgentsListParams, AgentsListResult>()(
        "agents.list",
        "workspace",
        agentsListSchema,
    ),
    agentsContent: row<AgentsContentParams, AgentsContentResult>()(
        "agents.content",
        "workspace",
        agentsContentSchema,
    ),
    agentsWrite: row<AgentsWriteParams, AgentsWriteResult>()(
        "agents.write",
        "workspace",
        agentsWriteSchema,
    ),
    agentsDelete: row<AgentsDeleteParams, AgentsDeleteResult>()(
        "agents.delete",
        "workspace",
        agentsDeleteSchema,
    ),
    skillsList: row<SkillsListParams, SkillsListResult>()(
        "skills.list",
        "workspace",
        skillsListSchema,
    ),
    skillContent: row<SkillContentParams, SkillContentResult>()(
        "skills.content",
        "workspace",
        skillContentSchema,
    ),
    mcpListServers: row<McpListServersParams, McpListServersResult>()(
        "mcp.listServers",
        "process",
        mcpListServersSchema,
    ),
    mcpGetConfig: row<McpGetConfigParams, McpGetConfigResult>()(
        "mcp.getConfig",
        "process",
        mcpGetConfigSchema,
    ),
    mcpCreateConfig: row<McpCreateConfigParams, McpMutateConfigResult>()(
        "mcp.createConfig",
        "process",
        mcpCreateConfigSchema,
    ),
    mcpUpdateConfig: row<McpUpdateConfigParams, McpMutateConfigResult>()(
        "mcp.updateConfig",
        "process",
        mcpUpdateConfigSchema,
    ),
    mcpDeleteConfig: row<McpDeleteConfigParams, McpDeleteConfigResult>()(
        "mcp.deleteConfig",
        "process",
        mcpDeleteConfigSchema,
    ),
};

export const miscMethods = domainMethods(miscRows);
export const miscContract = domainContract(miscRows);
export const miscSchemas = domainSchemas(miscRows);
