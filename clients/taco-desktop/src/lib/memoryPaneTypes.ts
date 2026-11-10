import type { MemoryListResult, MemoryTopicEntry } from "@taco-ai/protocol";

/** Left-column row ID for the global MEMORY.md entry. Topic ids are file stems,
 *  so this value can never collide with any topic id. */
export const MEMORY_ROOT_ID = "__memory_root__";

/** Prefix for archived-topic selection, so an archived id cannot collide with a live one. */
export const MEMORY_ARCHIVE_PREFIX = "archive:";

/** Stable list identity; inherited layers may repeat a topic id across workspaces. */
export function memoryTopicRowId(
    topic: Pick<MemoryTopicEntry, "id" | "memoryLayer" | "memoryLayerKey">,
): string {
    if (!topic.memoryLayer || topic.memoryLayer === "current") return topic.id;
    return `${topic.memoryLayer}:${topic.memoryLayerKey ?? ""}:${topic.id}`;
}

/** Shape of the `data` field after unwrapping RpcHandlerError("memory.conflict"). */
export interface MemoryConflictPayload {
    currentContent: string;
    currentHash: string;
}

export type { MemoryListResult, MemoryTopicEntry };
