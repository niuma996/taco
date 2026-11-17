/** Git discovery does not require constructing a workspace runtime. */
import { Type } from "typebox";
import type { GitInspectResult, WorktreeListResult } from "../git.js";
import { workspaceIdSchema } from "../schemas/fields.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const workspaceSchema = Type.Object(
    { workspace: workspaceIdSchema },
    { additionalProperties: false },
);
const gitRows = {
    gitInspect: row<GitInspectResult>()("git.inspect", "workspace", workspaceSchema),
    gitInit: row<GitInspectResult>()("git.init", "workspace", workspaceSchema),
    worktreeList: row<WorktreeListResult>()("worktree.list", "workspace", workspaceSchema),
};
export const gitMethods = domainMethods(gitRows);
export const gitContract = domainContract(gitRows);
export const gitSchemas = domainSchemas(gitRows);
