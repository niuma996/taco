/** Coordinates Git mutations with workspace admission; history and project memory outlive a checkout. */
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { asWorkspaceId, type WorktreeChangedParams } from "@taco-ai/protocol";
import {
    createGitWorktree,
    listManagedGitWorktrees,
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
    return {
        list: listManagedGitWorktrees,
        async create(cwd: string, name: string, base?: "head" | "default") {
            const { projectRoot, ...result } = await createGitWorktree(cwd, name, base);
            options.onChange({
                projectRoot,
                path: result.path,
                kind: "created",
            });
            return result;
        },
        async remove(cwd: string, path: string) {
            if (!isAbsolute(path))
                throw new RpcHandlerError("invalid_params", "工作树路径必须是绝对路径。");
            const target = workspaceAccessPath(path);
            return options.gate.cleanup(asWorkspaceId(target), async () => {
                const affected: WorkspaceRuntime[] = [];
                for (const runtime of options.runtimes()) {
                    const execution = await realpath(runtime.executionCwd).catch(
                        () => runtime.executionCwd,
                    );
                    const usesDirectory =
                        workspacePathsOverlap(target, execution) ||
                        runtime
                            .associatedRoots()
                            .some((root) =>
                                workspacePathsOverlap(workspaceAccessPath(root), target),
                            );
                    if (!usesDirectory) continue;
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
                if (await options.hasActiveWork(target))
                    throw new RpcHandlerError(
                        "invalid_state",
                        "工作树仍有后台任务或排队任务，暂不能删除。",
                    );
                const projectRoot = await resolveGitProjectRoot(target);
                // Git validates ownership, locks and dirty files before removing anything.
                const result = await removeGitWorktree(cwd, target, {
                    beforeRemove: async () => {
                        if (await options.hasActiveWork(target))
                            throw new RpcHandlerError(
                                "invalid_state",
                                "工作树仍有后台任务或排队任务，暂不能删除。",
                            );
                        for (const runtime of affected) await options.dispose(runtime.workspaceKey);
                    },
                });
                options.onChange({
                    projectRoot: projectRoot ?? cwd,
                    path: target,
                    kind: "removed",
                });
                return result;
            });
        },
    };
}
