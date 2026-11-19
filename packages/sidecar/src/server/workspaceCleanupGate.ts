import type { WorkspaceId } from "@taco-ai/protocol";
import { workspaceAccessPath, workspacePathsOverlap } from "../workspace/pathIdentity.ts";
import { RpcHandlerError } from "./methodRegistry.ts";

/** Admission is synchronous so no await can slip new work past the cleanup check. */
export class WorkspaceCleanupGate {
    private readonly cleaning = new Set<string>();
    private readonly active = new Map<string, number>();

    constructor(private readonly executionAliases: (key: string) => readonly string[] = () => []) {}

    /** Includes execution and explicit directory grants, without constructing a runtime. */
    accessRoots(cwd: string): string[] {
        return [...new Set([cwd, ...this.executionAliases(cwd)].map(workspaceAccessPath))];
    }

    assertAvailable(cwd: string): void {
        if (
            [...this.cleaning].some((key) =>
                this.accessRoots(cwd).some((candidate) => workspacePathsOverlap(key, candidate)),
            )
        ) {
            throw new RpcHandlerError("invalid_state", "工作区正在清理，请稍后重试。");
        }
    }

    async run<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
        this.assertAvailable(cwd);
        const keys = this.accessRoots(cwd);
        for (const key of keys) this.active.set(key, (this.active.get(key) ?? 0) + 1);
        try {
            return await operation();
        } finally {
            for (const key of keys) {
                const count = (this.active.get(key) ?? 1) - 1;
                if (count) this.active.set(key, count);
                else this.active.delete(key);
            }
        }
    }

    async cleanup<T>(cwd: WorkspaceId, operation: () => Promise<T>): Promise<T> {
        this.assertAvailable(cwd);
        const keys = this.accessRoots(cwd);
        if (
            [...this.active.keys()].some((active) =>
                keys.some((key) => workspacePathsOverlap(key, active)),
            )
        ) {
            throw new RpcHandlerError(
                "invalid_state",
                "工作区有活动请求或任务，请等待结束后再清理。",
            );
        }
        for (const key of keys) this.cleaning.add(key);
        try {
            return await operation();
        } finally {
            for (const key of keys) this.cleaning.delete(key);
        }
    }
}
