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
    readonly release?: () => Promise<void>;
    readonly owned?: boolean;
}

export function createWorkspaceStores(
    owners: WorkspaceResourceOwners,
    options: { memoryEnabled?: boolean; checkpointsEnabled?: boolean } = {},
): WorkspaceStores {
    const memory = options.memoryEnabled !== false ? new LocalMemoryStore() : new NoOpMemoryStore();
    memory.initialize(owners.memory);
    let released = false;
    return {
        memory,
        checkpoint:
            options.checkpointsEnabled !== false
                ? new CheckpointStore(owners.checkpoint)
                : undefined,
        owned: true,
        release: async () => {
            if (released) return;
            released = true;
        },
    };
}

const releasedStores = new WeakSet<object>();

export async function releaseWorkspaceStores(stores: WorkspaceStores): Promise<void> {
    if (stores.owned === false || releasedStores.has(stores)) return;
    releasedStores.add(stores);
    await stores.release?.();
}
