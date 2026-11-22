import type { GitInspectResult, GitWorktreeInfo, WorktreeListResult } from "@taco-ai/protocol";

/** Git canonicalizes both paths; linked checkouts have per-worktree metadata. */
export function isLinkedWorktree(data: GitInspectResult): boolean {
    if (data.status !== "repository" || data.repository.isBare) return false;
    return data.repository.gitDir !== data.repository.commonDir;
}

export function mainWorktreePath(data: Extract<WorktreeListResult, { status: "repository" }>) {
    // Git lists the main entry first; checkoutRoot belongs to the queried checkout.
    return data.projectRoot ?? data.worktrees[0]?.path ?? data.repository.checkoutRoot;
}

export function worktreeAvailable(tree: GitWorktreeInfo) {
    return !tree.bare && !tree.prunable && !tree.orphaned;
}

/** Separate Git directories report the admin directory as their first porcelain entry. */
export function navigationWorktrees(data: Extract<WorktreeListResult, { status: "repository" }>) {
    const [main, ...linked] = data.worktrees;
    if (!main || main.bare || main.path !== data.repository.commonDir) return data.worktrees;
    return [
        data.projectRoot ? { ...main, path: data.projectRoot } : { ...main, prunable: true },
        ...linked,
    ];
}
