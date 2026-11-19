/** Local checkout validity is independent of history/storage ownership. */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { listGitWorktrees } from "../git/gitService.ts";
import { gitDirectoryIdentity } from "./gitIdentity.ts";
import { workspaceAccessPath } from "./pathIdentity.ts";
import type { WorkspaceScope } from "./workspaceScope.ts";
import { isSafeWorktreeName, WorktreeMetadataStore } from "./worktreeMetadata.ts";

export class WorkspaceUnavailableError extends Error {
    constructor() {
        super("工作树目录已移除或已替换，仅可查看历史记录。请创建工作树后继续执行。");
        this.name = "WorkspaceUnavailableError";
    }
}

async function managedCheckout(cwd: string) {
    for (let tree = workspaceAccessPath(cwd); dirname(tree) !== tree; tree = dirname(tree)) {
        const container = dirname(tree);
        const taco = dirname(container);
        if (
            basename(container) !== "worktrees" ||
            basename(taco) !== ".taco" ||
            !isSafeWorktreeName(basename(tree))
        )
            continue;
        const store = new WorktreeMetadataStore(await realpath(dirname(taco)));
        const record = await store.get(tree);
        if (record) return { store, record };
    }
    return undefined;
}

/**
 * Capture a server runtime's expected checkout once. History-only runtimes never
 * become executable just because a writer recreates their directory. Ordinary
 * workspaces and IM retain their existing policy; direct runtime callers opt in.
 */
export async function createExecutionValidator(
    scope: WorkspaceScope,
): Promise<(() => Promise<void>) | undefined> {
    if (scope.kind !== "local") return undefined;
    try {
        const managed = await managedCheckout(scope.executionCwd);
        if (!managed && scope.projectRoot === scope.executionCwd) return undefined;
        if (managed?.record.state === "removed") throw new WorkspaceUnavailableError();
        const initial = await listGitWorktrees(scope.executionCwd);
        if (
            initial.status !== "repository" ||
            initial.repository.isBare ||
            !initial.repository.checkoutRoot
        )
            throw new WorkspaceUnavailableError();
        const expected = initial.repository;
        const checkoutRoot = await realpath(initial.repository.checkoutRoot);
        const commonIdentity = await gitDirectoryIdentity(expected.commonDir);
        const gitIdentity = await gitDirectoryIdentity(expected.gitDir);
        if (expected.gitDir === expected.commonDir) throw new WorkspaceUnavailableError();
        if (
            managed &&
            (checkoutRoot !== managed.record.path ||
                expected.gitDir !== managed.record.gitDir ||
                expected.commonDir !== managed.record.commonDir ||
                commonIdentity !== managed.record.repositoryIdentity ||
                gitIdentity !== managed.record.gitDirIdentity)
        )
            throw new WorkspaceUnavailableError();

        return async () => {
            try {
                if (!(await stat(scope.executionCwd)).isDirectory())
                    throw new WorkspaceUnavailableError();
                if (managed) {
                    const current = await managed.store.get(managed.record.path);
                    if (
                        !current ||
                        current.state === "removed" ||
                        current.gitDirIdentity !== gitIdentity ||
                        current.repositoryIdentity !== commonIdentity
                    )
                        throw new WorkspaceUnavailableError();
                }
                // Inventory/probe reads Git metadata only, never a full working-tree status.
                const current = await listGitWorktrees(scope.executionCwd);
                if (
                    current.status !== "repository" ||
                    current.repository.isBare ||
                    !current.repository.checkoutRoot ||
                    (await realpath(current.repository.checkoutRoot)) !== checkoutRoot ||
                    current.repository.gitDir !== expected.gitDir ||
                    current.repository.commonDir !== expected.commonDir ||
                    (await gitDirectoryIdentity(expected.commonDir)) !== commonIdentity ||
                    (await gitDirectoryIdentity(expected.gitDir)) !== gitIdentity ||
                    !current.worktrees.some(
                        (tree) =>
                            tree.path === expected.checkoutRoot && !tree.bare && !tree.prunable,
                    )
                )
                    throw new WorkspaceUnavailableError();
            } catch {
                throw new WorkspaceUnavailableError();
            }
        };
    } catch {
        return async () => {
            throw new WorkspaceUnavailableError();
        };
    }
}
