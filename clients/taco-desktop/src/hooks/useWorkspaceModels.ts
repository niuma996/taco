import type { WorkspaceId } from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ModelOption } from "../components/settings/ModelPicker";
import type { TacoClient } from "../lib/clients/tacoClient";
import {
    catalogQueryPolicy,
    queryError,
    refreshQueries,
    resourceQueryKey,
} from "../lib/queries/queryClient";

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
    const queryClient = useQueryClient();
    const query = useQuery({
        ...catalogQueryPolicy,
        queryKey: resourceQueryKey(client, "models", workspace),
        enabled: enabled && workspace !== null,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.sessionListModels({ workspace: workspace as WorkspaceId });
        },
    });
    const refresh = useCallback(() => {
        if (enabled && workspace)
            void refreshQueries(queryClient, {
                queryKey: resourceQueryKey(client, "models", workspace),
            });
    }, [client, queryClient, enabled, workspace]);
    return {
        options: query.data?.models ?? [],
        loading: query.isFetching,
        error: queryError(query.error),
        refresh,
    };
}
