/** Resource ownership is independent of the workspace's public routing key. */
import { CheckpointStore } from "../checkpoints/store.ts";
import { LocalMemoryStore } from "../memory/local/store.ts";
import { NoOpMemoryStore } from "../memory/noopStore.ts";
import type { MemoryStore } from "../memory/types.ts";
import type { WorkspaceScope } from "./workspaceScope.ts";

export interface WorkspaceResourceOwners {
    readonly memory: string;
    readonly checkpoint: string;
    readonly configCwd: string;
}

/** Preserve existing partitions; execution-policy changes never merge IM memories. */
export function resolveWorkspaceResourceOwners(scope: WorkspaceScope): WorkspaceResourceOwners {
    return {
        memory:
            scope.kind === "im"
                ? scope.key
                : scope.projectRoot === scope.executionCwd
                  ? scope.sessionCwd
                  : scope.projectRoot,
        checkpoint: scope.executionCwd,
        configCwd: scope.kind === "im" ? scope.executionCwd : scope.projectRoot,
    };
}

/** Stores are file-backed and do not expose a runtime disposal operation. */
export interface WorkspaceStores {
    readonly memory: MemoryStore;
    readonly checkpoint: CheckpointStore | undefined;
}

export function createWorkspaceStores(
    owners: WorkspaceResourceOwners,
    options: {
        memoryEnabled?: boolean;
        checkpointsEnabled?: boolean;
        memoryStore?: MemoryStore;
    } = {},
): WorkspaceStores {
    const memory =
        options.memoryEnabled !== false
            ? (options.memoryStore ?? new LocalMemoryStore())
            : new NoOpMemoryStore();
    memory.initialize(owners.memory);
    return {
        memory,
        checkpoint:
            options.checkpointsEnabled !== false
                ? new CheckpointStore(owners.checkpoint)
                : undefined,
    };
}
