/** Git repository facts and worktree inventory; paths retain filesystem spelling. */
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
}
export type WorktreeListResult =
    | GitUnavailable
    | {
          status: "repository";
          repository: GitRepositoryInfo;
          worktrees: GitWorktreeInfo[];
      };
