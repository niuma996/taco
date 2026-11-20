/** Coordinates Git mutations with workspace admission; history and memory outlive a checkout. */
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
    asWorkspaceId,
    type WorktreeBase,
    type WorktreeChangedParams,
    type WorktreeCleanupParams,
    type WorktreeCleanupResult,
    type WorktreeRemoveResult,
} from "@taco-ai/protocol";
import {
    createGitWorktree,
    listManagedGitWorktrees,
    readWorktreeInventory,
    removeGitWorktree,
    resolveGitProjectRoot,
} from "../git/gitService.ts";
import type { WorkspaceRuntime } from "../runtime/workspace.ts";
import { workspaceAccessPath, workspacePathsOverlap } from "../workspace/pathIdentity.ts";
import { RpcHandlerError } from "./methodRegistry.ts";
import type { WorkspaceCleanupGate } from "./workspaceCleanupGate.ts";

interface WorktreeControlOptions {
    gate: WorkspaceCleanupGate;
    runtimes(): WorkspaceRuntime[];
    hasActiveWork(key: string): Promise<boolean>;
    dispose(key: ReturnType<typeof asWorkspaceId>): Promise<void>;
    onChange(params: WorktreeChangedParams): void;
}

export function createWorktreeControl(options: WorktreeControlOptions) {
    async function remove(
        cwd: string,
        path: string,
        expectedGitDirIdentity?: string,
    ): Promise<WorktreeRemoveResult> {
        if (!isAbsolute(path))
            throw new RpcHandlerError("invalid_params", "工作树路径必须是绝对路径。");
        const target = workspaceAccessPath(path);
        return options.gate.cleanup(asWorkspaceId(target), async () => {
            const affected: WorkspaceRuntime[] = [];
            for (const runtime of options.runtimes()) {
                const execution = await realpath(runtime.executionCwd).catch(
                    () => runtime.executionCwd,
                );
                if (
                    !workspacePathsOverlap(target, execution) &&
                    !runtime
                        .associatedRoots()
                        .some((root) => workspacePathsOverlap(workspaceAccessPath(root), target))
                )
                    continue;
                if (
                    runtime.sessionRegistry.attachedCount > 0 ||
                    (await options.hasActiveWork(runtime.workspaceKey))
                )
                    throw new RpcHandlerError(
                        "invalid_state",
                        "工作树仍有已连接会话或后台任务，请先结束并断开会话。",
                    );
                affected.push(runtime);
            }
            const assertIdle = async () => {
                if (await options.hasActiveWork(target))
                    throw new RpcHandlerError(
                        "invalid_state",
                        "工作树仍有后台任务或排队任务，暂不能删除。",
                    );
            };
            await assertIdle();
            const projectRoot = await resolveGitProjectRoot(target);
            const result = await removeGitWorktree(cwd, target, {
                expectedGitDirIdentity,
                beforeRemove: async () => {
                    await assertIdle();
                    for (const runtime of affected) await options.dispose(runtime.workspaceKey);
                },
            });
            options.onChange({ projectRoot: projectRoot ?? cwd, path: target, kind: "removed" });
            return result;
        });
    }

    return {
        list: listManagedGitWorktrees,
        async create(cwd: string, name: string, base?: WorktreeBase) {
            const { projectRoot, ...result } = await createGitWorktree(cwd, name, base);
            options.onChange({ projectRoot, path: result.path, kind: "created" });
            return result;
        },
        remove: (cwd: string, path: string) => remove(cwd, path),
        async cleanup(
            cwd: string,
            settings: Omit<WorktreeCleanupParams, "workspace"> = {},
        ): Promise<WorktreeCleanupResult> {
            const result: WorktreeCleanupResult = { removed: [], skipped: [], failed: [] };
            const { inventory, records } = await readWorktreeInventory(cwd);
            if (inventory.status !== "repository" || !inventory.projectRoot) return result;
            // Keep a stable source even if this sweep removes its caller's checkout.
            const projectRoot = inventory.projectRoot;
            const byPath = new Map(records.map((record) => [record.path, record]));
            const candidates = inventory.worktrees
                .flatMap((tree) => {
                    const record = byPath.get(tree.path);
                    if (!record || !tree.managed || tree.orphaned || tree.bare || tree.prunable)
                        return [];
                    return [{ tree, record }];
                })
                .sort(
                    (a, b) =>
                        Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt) ||
                        a.tree.path.localeCompare(b.tree.path),
                );
            const cutoff = Date.now() - (settings.maxAgeDays ?? 14) * 86_400_000;
            for (const [index, { tree, record }] of candidates.entries()) {
                if (tree.detached) {
                    result.skipped.push({ path: tree.path, reason: "detached" });
                    continue;
                }
                if (tree.locked) {
                    result.skipped.push({ path: tree.path, reason: "locked" });
                    continue;
                }
                // A persisted intent remains retryable even if the caller changes thresholds.
                if (
                    record.state !== "removing" &&
                    Date.parse(record.createdAt) > cutoff &&
                    index < (settings.maxCount ?? 15)
                )
                    continue;
                try {
                    result.removed.push(
                        await remove(projectRoot, tree.path, record.gitDirIdentity),
                    );
                } catch (error) {
                    result.failed.push({
                        path: tree.path,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            for (const tree of inventory.worktrees) {
                if (tree.orphaned) result.skipped.push({ path: tree.path, reason: "orphaned" });
                else if (tree.prunable)
                    result.skipped.push({ path: tree.path, reason: "prunable" });
            }
            return result;
        },
    };
}
