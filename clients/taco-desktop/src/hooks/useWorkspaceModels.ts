import type { WorkspaceId } from "@taco-ai/protocol";
/**
 * Loads available models for a workspace.
 * Workspace changes fetch automatically; `refresh()` fetches on demand.
 * Stable callbacks read current inputs without duplicate effect requests.
 */
import { useCallback, useEffect, useState } from "react";
import type { ModelOption } from "../components/settings/ModelPicker";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useStableCallback } from "./primitives/useStableCallback";
import { useRetryOnError } from "./primitives/useRetryOnError";

export interface UseWorkspaceModelsResult {
    loading: boolean;
    options: ModelOption[];
    error: Error | null;
    refresh: () => void;
}

export function useWorkspaceModels(
    client: TacoClient,
    workspace: WorkspaceId | null,
    enabled = true,
): UseWorkspaceModelsResult {
    const [loading, setLoading] = useState(false);
    const [options, setOptions] = useState<ModelOption[]>([]);
    const [error, setError] = useState<Error | null>(null);
    const [refreshCount, setRefreshCount] = useState(0);
    // Stable ref — useRetryOnError stabilizes the setTimeout, preventing timer reset per render.
    const refresh = useCallback(() => setRefreshCount((n) => n + 1), []);

    /**
     * Fetches models and returns cleanup that blocks stale in-flight writes.
     * The stable callback reads the latest inputs without changing identity.
     */
    const fetchModels = useStableCallback((): (() => void) => {
        if (!enabled || !workspace) return () => {};
        let cancelled = false;
        setLoading(true);
        client
            .sessionListModels(workspace)
            .then((res) => {
                if (cancelled) return;
                setOptions(res.models);
                setError(null);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err : new Error(String(err)));
                // Retain previous options on failure to avoid UI flicker.
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    });

    // Mount fetch and dependency-driven refetch; clear options when workspace is unset.
    useEffect(() => {
        if (!enabled) {
            // not yet ensured on the backend — keep prior state, don't fetch
            return;
        }
        if (!workspace) {
            setOptions([]);
            setError(null);
            return;
        }
        return fetchModels();
    }, [workspace, enabled, fetchModels]);

    // refresh effect: only depends on refreshCount; client/workspace/enabled are read via the stable callback.
    useEffect(() => {
        if (refreshCount === 0) return; // Skip initial mount.
        return fetchModels();
    }, [refreshCount, fetchModels]);

    // Auto-retry with backoff on failure — avoids permanent stall from cold-start race (RPC before sidecar ready).
    useRetryOnError(error, refresh);

    return { loading, options, error, refresh };
}
