/**
 * No-op MemoryStore used when memory is disabled.
 *
 * All methods are zero-cost no-ops. `appendEntry` / `writeMemory` / `deleteTopic` /
 * `updateTopic` resolve immediately so callers can `await` them uniformly.
 */

import type { MemoryEntry, MemoryStore } from "./types.ts";

export class NoOpMemoryStore implements MemoryStore {
    readonly enabled = false;

    initialize(_workspaceId: string): void {}

    async appendEntry(_entry: MemoryEntry): Promise<void> {}

    readMemory(): string {
        return "";
    }

    buildMemoryBlock(): string {
        return "";
    }

    async writeMemory(_content: string, _baseHash: string): Promise<void> {}

    listTopics(): MemoryEntry[] {
        return [];
    }

    async deleteTopic(_id: string): Promise<void> {}

    getTopic(_id: string): MemoryEntry | undefined {
        return undefined;
    }

    async updateTopic(_id: string, _content: string): Promise<MemoryEntry> {
        return {
            id: _id,
            name: "",
            description: "",
            type: "user",
            content: _content,
            createdAt: new Date(0).toISOString(),
        };
    }
}
