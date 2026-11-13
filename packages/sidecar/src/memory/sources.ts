/**
 * Resolve the read-only memory layers inherited by one workspace or IM chat.
 *
 * Current-target writes stay on `store`. Associated workspace memory follows
 * the association grant automatically; Taco's cross-workspace memory is an
 * explicit opt-in for IM conversations. Both inherited layers are resolved
 * live because association and policy edits apply without rebuilding the
 * workspace runtime.
 */

import { isAbsolute, resolve } from "node:path";
import { buildMemoryContextBlock } from "./contextBlock.ts";
import { LocalMemoryStore, workspaceKey } from "./local/store.ts";
import type { MemoryEntry, MemoryStore } from "./types.ts";

export type MemoryTargetKind = "workspace" | "channel";

export interface MemoryLayerEntries {
    readonly key: string;
    readonly label: string;
    readonly entries: readonly MemoryEntry[];
}

export interface ResolvedMemorySources {
    readonly target: MemoryTargetKind;
    readonly memoryContent: string;
    readonly current: readonly MemoryEntry[];
    readonly currentSourceId?: string;
    readonly associatedWorkspaces: readonly MemoryLayerEntries[];
    readonly managedGlobal: readonly MemoryLayerEntries[];
}

export interface ResolveMemorySourcesOptions {
    readonly store: MemoryStore;
    readonly target: MemoryTargetKind;
    readonly associatedRoots: readonly string[];
    readonly inheritManagedGlobal: boolean;
    /** Explicit filesystem workspace identities supplied by the server registry. */
    readonly managedGlobalRoots?: readonly string[];
}

function lastSegment(root: string): string {
    return (
        root
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || root
    );
}

function dedupeRoots(roots: readonly string[]): string[] {
    return Array.from(new Set(roots.filter(isAbsolute).map((root) => resolve(root))));
}

// Cache lifetime follows the current store; revoked sources are removed on the
// next read. Reusing stores preserves their file-signature cache across turns.
const inheritedStores = new WeakMap<LocalMemoryStore, Map<string, LocalMemoryStore>>();

function readLayers(current: LocalMemoryStore, roots: readonly string[]): MemoryLayerEntries[] {
    const stores = inheritedStores.get(current) ?? new Map<string, LocalMemoryStore>();
    inheritedStores.set(current, stores);
    const activeKeys = new Set(roots.map(workspaceKey));
    for (const key of stores.keys()) {
        if (!activeKeys.has(key)) stores.delete(key);
    }
    const names = roots.map((root) =>
        lastSegment(root)
            .replace(/[\r\n]+/g, " ")
            .slice(0, 80),
    );
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    const seen = new Map<string, number>();
    return roots.map((root, index) => {
        const key = workspaceKey(root);
        let store = stores.get(key);
        if (!store) {
            store = LocalMemoryStore.openByKey(key);
            stores.set(key, store);
        }
        const name = names[index] ?? "Workspace";
        const ordinal = (seen.get(name) ?? 0) + 1;
        seen.set(name, ordinal);
        return {
            key: root,
            label: (counts.get(name) ?? 0) > 1 ? `${name} #${ordinal}` : name,
            entries: store.listTopics(),
        };
    });
}

export function resolveMemorySources(options: ResolveMemorySourcesOptions): ResolvedMemorySources {
    const associatedRoots =
        options.target === "channel" ? dedupeRoots(options.associatedRoots) : [];
    const current = options.store;
    const excluded = new Set(associatedRoots.map(workspaceKey));
    if (current instanceof LocalMemoryStore) excluded.add(current.dirKey);
    const managedRoots =
        options.target === "channel" && options.inheritManagedGlobal
            ? dedupeRoots(options.managedGlobalRoots ?? []).filter(
                  (root) => !excluded.has(workspaceKey(root)),
              )
            : [];
    const layers =
        current instanceof LocalMemoryStore && current.enabled
            ? readLayers(current, [...associatedRoots, ...managedRoots])
            : [];
    const associatedWorkspaces = layers.slice(0, associatedRoots.length);
    const managedGlobal = layers.slice(associatedRoots.length);

    return {
        target: options.target,
        memoryContent: options.store.readMemory(),
        current: options.store.listTopics(),
        ...(current instanceof LocalMemoryStore ? { currentSourceId: current.dirKey } : {}),
        associatedWorkspaces,
        managedGlobal,
    };
}

/** Human MEMORY.md is verbatim; topic summaries share one count and byte budget. */
export function buildLayeredMemoryBlock(sources: ResolvedMemorySources): string {
    const memoryBody = sources.memoryContent.trim();
    const layers = [
        {
            label:
                sources.target === "channel"
                    ? "Current channel memory"
                    : "Current workspace memory",
            entries: sources.current,
            inherited: false,
            memoryLayer: "current",
            sourceId: sources.currentSourceId,
        },
        ...sources.associatedWorkspaces.map((layer) => ({
            label: `Associated workspace memory (${layer.label})`,
            entries: layer.entries,
            inherited: true,
            memoryLayer: "workspace",
            sourceId: workspaceKey(layer.key),
        })),
        ...sources.managedGlobal.map((layer) => ({
            label: `Taco system memory (${layer.label})`,
            entries: layer.entries,
            inherited: true,
            memoryLayer: "managed-global",
            sourceId: workspaceKey(layer.key),
        })),
    ];
    return buildMemoryContextBlock(
        memoryBody && memoryBody !== "# Memory" ? memoryBody : "",
        layers.map((layer) => ({
            heading: `${layer.label} (newest first${layer.inherited ? "; inherited entries are read-only" : ""}; use memory action=read with the shown reference):`,
            entries: layer.entries,
            ...(layer.sourceId
                ? {
                      readReference: (topic: MemoryEntry) =>
                          JSON.stringify({
                              memoryLayer: layer.memoryLayer,
                              sourceId: layer.sourceId,
                              id: topic.id,
                          }),
                  }
                : {}),
        })),
        { nameMaxChars: 160 },
    );
}
