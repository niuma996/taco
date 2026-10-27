/**
 * RPC contract rows — tools / agents / skills / mcp — the remaining read and configuration methods.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import type {
    McpDeleteConfigResult,
    McpGetConfigResult,
    McpListServersResult,
    McpMutateConfigResult,
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
    AgentsContentResult,
    AgentsDeleteResult,
    AgentsListResult,
    AgentsWriteResult,
    SkillContentResult,
    SkillsListResult,
    ToolsListResult,
} from "../tools.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const miscRows = {
    toolsList: row<ToolsListResult>()("tools.list", "workspace", toolsListSchema),
    agentsList: row<AgentsListResult>()("agents.list", "workspace", agentsListSchema),
    agentsContent: row<AgentsContentResult>()("agents.content", "workspace", agentsContentSchema),
    agentsWrite: row<AgentsWriteResult>()("agents.write", "workspace", agentsWriteSchema),
    agentsDelete: row<AgentsDeleteResult>()("agents.delete", "workspace", agentsDeleteSchema),
    skillsList: row<SkillsListResult>()("skills.list", "workspace", skillsListSchema),
    skillContent: row<SkillContentResult>()("skills.content", "workspace", skillContentSchema),
    mcpListServers: row<McpListServersResult>()("mcp.listServers", "process", mcpListServersSchema),
    mcpGetConfig: row<McpGetConfigResult>()("mcp.getConfig", "process", mcpGetConfigSchema),
    mcpCreateConfig: row<McpMutateConfigResult>()(
        "mcp.createConfig",
        "process",
        mcpCreateConfigSchema,
    ),
    mcpUpdateConfig: row<McpMutateConfigResult>()(
        "mcp.updateConfig",
        "process",
        mcpUpdateConfigSchema,
    ),
    mcpDeleteConfig: row<McpDeleteConfigResult>()(
        "mcp.deleteConfig",
        "process",
        mcpDeleteConfigSchema,
    ),
};

export const miscMethods = domainMethods(miscRows);
export const miscContract = domainContract(miscRows);
export const miscSchemas = domainSchemas(miscRows);
