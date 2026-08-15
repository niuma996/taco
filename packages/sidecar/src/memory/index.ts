/**
 * Memory plugin — public exports.
 *
 * Storage layout:
 *   ~/.taco/memory/
 *   ├── MEMORY.md                             ← user-level, append-only H2 sections
 *   └── projects/
 *       └── {workspaceKey(workspaceId)}/      ← sha256(cwd).slice(0,16), portable dir name
 *           └── *.md                          ← topic files with frontmatter
 */

export {
    MemoryExtractorImpl,
    sliceForExtraction,
} from "./local/extractor.ts";
export {
    hashOf,
    LocalMemoryStore,
    parseTopicFrontmatter,
    readProjectTopics,
    workspaceKey,
} from "./local/store.ts";
export { buildMemoryContextHook } from "./memoryTag.ts";
export { NoOpMemoryStore } from "./noopStore.ts";
export type {
    MEMORY_ENTRY_TYPES,
    MemoryEntry,
    MemoryEntryType,
    MemoryExtractor,
    MemoryStore,
} from "./types.ts";
export { MemoryConflictError } from "./types.ts";
