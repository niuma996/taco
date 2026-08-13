import type { MemoryListResult, MemoryTopicEntry } from "@taco-ai/protocol";

/** Left-column row ID for the global MEMORY.md entry. Topic ids are file stems,
 *  so this value can never collide with any topic id. */
export const MEMORY_ROOT_ID = "__memory_root__";

/** Shape of the `data` field after unwrapping RpcHandlerError("memory.conflict"). */
export interface MemoryConflictPayload {
    currentContent: string;
    currentHash: string;
}

export type { MemoryListResult, MemoryTopicEntry };
