/** Git discovery does not require constructing a workspace runtime. */
import type {
    GitInspectResult,
    WorktreeCreateResult,
    WorktreeListResult,
    WorktreeRemoveResult,
} from "../git.js";
import {
    gitInitSchema,
    gitInspectSchema,
    worktreeCreateSchema,
    worktreeListSchema,
    worktreeRemoveSchema,
} from "../schemas/git.js";
import { domainContract, domainMethods, domainSchemas, row } from "./types.js";

const gitRows = {
    gitInspect: row<GitInspectResult>()("git.inspect", "workspace", gitInspectSchema),
    gitInit: row<GitInspectResult>()("git.init", "workspace", gitInitSchema),
    worktreeList: row<WorktreeListResult>()("worktree.list", "workspace", worktreeListSchema),
    worktreeCreate: row<WorktreeCreateResult>()(
        "worktree.create",
        "workspace",
        worktreeCreateSchema,
    ),
    worktreeRemove: row<WorktreeRemoveResult>()(
        "worktree.remove",
        "workspace",
        worktreeRemoveSchema,
    ),
};
export const gitMethods = domainMethods(gitRows);
export const gitContract = domainContract(gitRows);
export const gitSchemas = domainSchemas(gitRows);
