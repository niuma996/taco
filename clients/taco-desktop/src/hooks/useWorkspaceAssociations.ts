/**
 * useWorkspaceAssociations — load + edit the directories a workspace may
 * reach beyond its own root.
 *
 * An association widens the COMMAND SCOPE of a workspace: the agent may
 * `cd` into an associated directory and run commands there. It is not a
 * merge of another workspace's configuration — tool configuration, MCP
 * servers and subagent toolsets stay anchored to the workspace's own root.
 *
 * The store lives on the sidecar, so every client sees the same sets and a
 * change made in one reaches the others. The `workspace.associations_changed`
 * push callback re-loads so other desktop windows stay in sync.
 *
 * Same gating/error pattern as `useImPolicy`: a local `error` string,
 * auto-cleared after 4s, and no callback ever throws.
 */
import type { WorkspaceAssociationKey } from "@taco-ai/protocol";
import { useCallback, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface UseWorkspaceAssociationsResult {
    /** The directories stored at the key, as absolute paths. */
    roots: string[];
    loading: boolean;
    saving: boolean;
    error: string | null;
    /** Pull the set stored at a key. */
    load: (key: WorkspaceAssociationKey) => Promise<string[]>;
    /**
     * Replace the set stored at a key. Pass the full list the user wants —
     * the store replaces rather than merges, so a partial update would need
     * a read-modify-write whose result could be stale by the time it lands.
     */
    save: (key: WorkspaceAssociationKey, roots: string[]) => Promise<boolean>;
    /** Called from the `workspace.associations_changed` push handler. */
    onAssociationsChanged: (key: WorkspaceAssociationKey) => void;
}

export function useWorkspaceAssociations(client: TacoClient): UseWorkspaceAssociationsResult {
    const [roots, setRoots] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    // The key the dialog last pulled. The push reload compares against it,
    // so a change to another key does not disturb what is on screen.
    const [loadedKey, setLoadedKey] = useState<string | null>(null);

    const { error, fail: failWith } = useAutoClearError();

    const load = useCallback(
        async (key: WorkspaceAssociationKey) => {
            setLoading(true);
            try {
                const result = await client.workspaceAssociationsGet(key);
                setRoots([...result.roots]);
                setLoadedKey(`${key.scope}:${key.id}`);
                return [...result.roots];
            } catch (e) {
                failWith(e);
                return [];
            } finally {
                setLoading(false);
            }
        },
        [client, failWith],
    );

    const save = useCallback(
        async (key: WorkspaceAssociationKey, next: string[]) => {
            setSaving(true);
            try {
                await client.workspaceAssociationsSet(key, next);
                return true;
            } catch (e) {
                failWith(e);
                return false;
            } finally {
                setSaving(false);
            }
        },
        [client, failWith],
    );

    const onAssociationsChanged = useCallback(
        (key: WorkspaceAssociationKey) => {
            if (`${key.scope}:${key.id}` !== loadedKey) return;
            void load(key);
        },
        [loadedKey, load],
    );

    return {
        roots,
        loading,
        saving,
        error,
        load,
        save,
        onAssociationsChanged,
    };
}
