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
 * change made in one reaches the others. The subscribing component listens
 * for `workspace.associations_changed` itself (see
 * `WorkspaceAssociationsDialog`), because only it knows which key is on
 * screen.
 *
 * Same gating/error pattern as `useImPolicy`: a local `error` string,
 * auto-cleared after 4s, and no callback ever throws.
 */
import type { WorkspaceAssociationKey } from "@taco-ai/protocol";
import { useCallback, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface UseWorkspaceAssociationsResult {
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
}

export function useWorkspaceAssociations(client: TacoClient): UseWorkspaceAssociationsResult {
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const { error, fail: failWith } = useAutoClearError();

    const load = useCallback(
        async (key: WorkspaceAssociationKey) => {
            setLoading(true);
            try {
                const result = await client.workspaceAssociationsGet(key);
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

    return {
        loading,
        saving,
        error,
        load,
        save,
    };
}
