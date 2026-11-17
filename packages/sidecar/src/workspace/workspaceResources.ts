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
        memory: scope.kind === "im" ? scope.key : scope.sessionCwd,
        checkpoint: scope.executionCwd,
        configCwd: scope.executionCwd,
    };
}

/** Borrowed by a runtime. Runtime disposal does not destroy these stores. */
export interface WorkspaceStores {
    readonly memory: MemoryStore;
    readonly checkpoint: CheckpointStore | undefined;
}

export function createWorkspaceStores(
    owners: WorkspaceResourceOwners,
    options: { memoryEnabled?: boolean; checkpointsEnabled?: boolean } = {},
): WorkspaceStores {
    const memory = options.memoryEnabled !== false ? new LocalMemoryStore() : new NoOpMemoryStore();
    memory.initialize(owners.memory);
    return {
        memory,
        checkpoint:
            options.checkpointsEnabled !== false
                ? new CheckpointStore(owners.checkpoint)
                : undefined,
    };
}
