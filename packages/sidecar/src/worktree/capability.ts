/** Git is probed at turn start; an unproven repository never receives the mutation tool. */
export function worktreeCapabilityFromInventory(inventory: {
    readonly status: string;
    readonly repository?: { readonly isBare: boolean; readonly headOid: string | null };
}): boolean {
    return (
        inventory.status === "repository" &&
        inventory.repository?.isBare === false &&
        inventory.repository.headOid !== null
    );
}

export function buildWorktreeGuidance(): string {
    return `<worktree_isolation>
Use worktreeStart before implementation when the requested change will write code and is complex or cross-module, high-risk (for example authentication, permissions, destructive data changes, or difficult rollback), or likely to conflict with parallel modifications. Also use it when the user explicitly asks for a worktree or an isolated branch.
Do not create a worktree for questions, read-only investigation, reviews, small low-risk edits, or work that deliberately continues on the current branch. If this session is already running in a linked worktree, continue in that checkout unless the user explicitly requests an additional worktree. The main checkout is not a linked worktree. A worktree_handoff notice means the current checkout already satisfies the original isolation request.
Before calling worktreeStart, finish the read-only inspection needed to choose a useful name and base. Use a short lowercase hyphenated name. Prefer the current HEAD; choose the default branch only when the task should start from the repository default. The new checkout starts from committed content: uncommitted changes are not copied, so preserve them in the source checkout and never commit or stash them merely to enable handoff.
Inspect Git status in the source checkout before handoff. The working_tree_changes tag, when present, lists uncommitted files in the current checkout; it does not identify linked worktrees. If the requested task depends on uncommitted source changes, do not use worktreeStart: explain that the isolated checkout would omit required work and continue in the source checkout or ask how the user wants to preserve it. An independent task may still start from a commit while unrelated source changes remain untouched.
worktreeStart creates a managed worktree and a new session, then executes the current user task there. Do not repeat the task or make the same edits in the source session after a successful call. Report the destination if the handoff fails; the tool retains any created session for inspection and retry.
For a steered or queued request without source-turn context, pass a self-contained task explicitly. Only an ordinary prompt automatically carries its verbatim text, images and attachments.
</worktree_isolation>`;
}
