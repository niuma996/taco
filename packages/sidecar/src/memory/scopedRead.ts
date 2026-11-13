import { type MemoryReadParams, memoryReadSelectorSchema } from "@taco-ai/protocol";
import { Value } from "typebox/value";
import { workspaceKey } from "./local/store.ts";
import { type ResolveMemorySourcesOptions, resolveMemorySources } from "./sources.ts";
import type { MemoryEntry } from "./types.ts";

/** Resolve the live grant before looking up an id; an opaque source id never opens a directory. */
export function readScopedMemoryTopic(
    options: ResolveMemorySourcesOptions,
    reference: Omit<MemoryReadParams, "workspace">,
): MemoryEntry {
    if (!options.store.enabled) throw new Error("memory is disabled");
    const unavailable = () => new Error("memory topic is not available in the authorized source");
    if (
        !Value.Check(memoryReadSelectorSchema, {
            memoryLayer: reference.memoryLayer,
            sourceId: reference.sourceId,
            id: reference.id,
        })
    ) {
        throw unavailable();
    }
    const sources = resolveMemorySources(options);
    let entries: readonly MemoryEntry[] | undefined;
    switch (reference.memoryLayer) {
        case "current":
            if (reference.sourceId === sources.currentSourceId) entries = sources.current;
            break;
        case "workspace":
            entries = sources.associatedWorkspaces.find(
                (layer) => workspaceKey(layer.key) === reference.sourceId,
            )?.entries;
            break;
        case "managed-global":
            entries = sources.managedGlobal.find(
                (layer) => workspaceKey(layer.key) === reference.sourceId,
            )?.entries;
            break;
    }
    const topic = entries?.find((entry) => entry.id === reference.id);
    if (!topic) throw unavailable();
    return topic;
}
