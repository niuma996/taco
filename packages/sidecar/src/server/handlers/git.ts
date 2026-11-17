/** Local Git metadata and inventory are available independently of agent plugins. */
import { isAbsolute } from "node:path";
import {
    GitServiceError,
    initializeGit,
    inspectGit,
    listGitWorktrees,
} from "../../git/gitService.ts";
import { RpcHandlerError, registerMethod } from "../methodRegistry.ts";

function localWorkspace(workspace: string): void {
    if (!isAbsolute(workspace))
        throw new RpcHandlerError(
            "invalid_params",
            "Git requires an absolute local workspace directory",
        );
}
async function gitResult<T>(workspace: string, operation: (cwd: string) => Promise<T>): Promise<T> {
    localWorkspace(workspace);
    try {
        return await operation(workspace);
    } catch (error) {
        if (error instanceof GitServiceError)
            throw new RpcHandlerError(
                error.reason === "invalid_path" ? "invalid_params" : "invalid_state",
                error.message,
                { reason: error.reason },
            );
        throw error;
    }
}

export function registerGitHandlers(): void {
    registerMethod("gitInspect", false, ({ params }) => gitResult(params.workspace, inspectGit));
    registerMethod("gitInit", false, ({ params }) => gitResult(params.workspace, initializeGit), {
        command: true,
    });
    registerMethod("worktreeList", false, ({ params }) =>
        gitResult(params.workspace, listGitWorktrees),
    );
}
