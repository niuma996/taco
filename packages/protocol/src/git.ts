/** Git repository facts and worktree inventory; paths retain filesystem spelling. */
import type { ParamsOf } from "./rpcContract/types.js";
import type {
    gitInitSchema,
    gitInspectSchema,
    worktreeCreateSchema,
    worktreeListSchema,
    worktreeRemoveSchema,
} from "./schemas/git.js";

export type GitInspectParams = ParamsOf<typeof gitInspectSchema>;
export type GitInitParams = ParamsOf<typeof gitInitSchema>;
export type WorktreeListParams = ParamsOf<typeof worktreeListSchema>;
export type WorktreeCreateParams = ParamsOf<typeof worktreeCreateSchema>;
export type WorktreeRemoveParams = ParamsOf<typeof worktreeRemoveSchema>;

export interface GitRepositoryInfo {
    checkoutRoot: string | null;
    gitDir: string;
    commonDir: string;
    isBare: boolean;
    headOid: string | null;
    branch: string | null;
}

export interface GitFileChange {
    /** Relative to the requested workspace, with forward-slash separators. */
    path: string;
    originalPath?: string;
    indexStatus: string;
    worktreeStatus: string;
    kind: "added" | "modified" | "deleted" | "renamed" | "conflict";
}

export type GitUnavailable = { status: "missing" | "not_repository" };
export type GitInspectResult =
    | GitUnavailable
    | {
          status: "repository";
          repository: GitRepositoryInfo;
          changes: GitFileChange[];
      };

export interface GitWorktreeInfo {
    path: string;
    headOid: string | null;
    branch: string | null;
    detached: boolean;
    bare: boolean;
    locked: boolean;
    lockReason?: string;
    prunable: boolean;
    pruneReason?: string;
    managed?: boolean;
}
export type WorktreeListResult =
    | GitUnavailable
    | {
          status: "repository";
          repository: GitRepositoryInfo;
          worktrees: GitWorktreeInfo[];
      };

export type WorktreeBase = NonNullable<WorktreeCreateParams["base"]>;

/** Process-level invalidation after worktree creation or removal. */
export interface WorktreeChangedParams {
    projectRoot: string;
    path: string;
    kind: "created" | "removed";
}

export interface WorktreeCreateResult {
    path: string;
    branch: string;
    headOid: string | null;
    managed: true;
}

export interface WorktreeRemoveResult {
    path: string;
    branch: string | null;
    removed: true;
}
