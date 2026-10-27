/**
 * RPC contract rows — tools / agents / skills — the catalog read methods.
 *
 * Each method is declared once as a row (wire name, scope, params/result
 * types, schema); `rpcContract/index.ts` derives the `RPC` / `rpcContract` /
 * `rpcSchemas` tables from those rows.
 */

import {
    agentsContentSchema,
    agentsDeleteSchema,
    agentsListSchema,
    agentsWriteSchema,
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
};

export const miscMethods = domainMethods(miscRows);
export const miscContract = domainContract(miscRows);
export const miscSchemas = domainSchemas(miscRows);
