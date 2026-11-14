import { resolve } from "node:path";
import { IM_CWD_PREFIX, type WorkspaceId } from "@taco-ai/protocol";
import { RpcHandlerError } from "./methodRegistry.ts";

/** Admission is synchronous so no await can slip new work past the cleanup check. */
export class WorkspaceCleanupGate {
    private readonly cleaning = new Set<string>();
    private readonly active = new Map<string, number>();

    private key(cwd: string): string {
        return cwd.startsWith(IM_CWD_PREFIX) ? cwd : resolve(cwd);
    }

    assertAvailable(cwd: string): void {
        if (this.cleaning.has(this.key(cwd))) {
            throw new RpcHandlerError("invalid_state", "工作区正在清理，请稍后重试。");
        }
    }

    async run<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
        this.assertAvailable(cwd);
        const key = this.key(cwd);
        this.active.set(key, (this.active.get(key) ?? 0) + 1);
        try {
            return await operation();
        } finally {
            const count = (this.active.get(key) ?? 1) - 1;
            if (count) this.active.set(key, count);
            else this.active.delete(key);
        }
    }

    async cleanup<T>(cwd: WorkspaceId, operation: () => Promise<T>): Promise<T> {
        this.assertAvailable(cwd);
        const key = this.key(cwd);
        if (this.active.has(key)) {
            throw new RpcHandlerError(
                "invalid_state",
                "工作区有活动请求或任务，请等待结束后再清理。",
            );
        }
        this.cleaning.add(key);
        try {
            return await operation();
        } finally {
            this.cleaning.delete(key);
        }
    }
}
