import type { ProviderView, WorkspaceId } from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { TacoClient } from "../lib/clients/tacoClient";
import {
    catalogQueryPolicy,
    queryError,
    refreshQueries,
    resourceQueryKey,
} from "../lib/queries/queryClient";

export interface UseProvidersResult {
    loading: boolean;
    providers: ProviderView[];
    error: Error | null;
    refresh: () => void;
}

export function useProviders(
    client: TacoClient,
    workspace: WorkspaceId | null,
    enabled = true,
): UseProvidersResult {
    const queryClient = useQueryClient();
    const query = useQuery({
        ...catalogQueryPolicy,
        queryKey: resourceQueryKey(client, "providers", workspace),
        enabled: enabled && workspace !== null,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.providersList({ workspace: workspace as WorkspaceId });
        },
    });
    const refresh = useCallback(() => {
        if (enabled && workspace)
            void refreshQueries(queryClient, {
                queryKey: resourceQueryKey(client, "providers", workspace),
            });
    }, [client, queryClient, enabled, workspace]);
    return {
        providers: query.data?.providers ?? [],
        loading: query.isFetching,
        error: queryError(query.error),
        refresh,
    };
}
