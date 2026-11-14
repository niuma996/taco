import { asWorkspaceId, type ToolEntry } from "@taco-ai/protocol";
import { useQuery } from "@tanstack/react-query";
import type { TacoClient } from "../lib/clients/tacoClient";
import { queryError, resourceQueryKey } from "../lib/queries/queryClient";

export interface UseToolsPaneResult {
    tools: ToolEntry[];
    error: string | null;
}

export function useToolsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
): UseToolsPaneResult {
    const query = useQuery({
        retry: false,
        queryKey: resourceQueryKey(client, "tools", activeCwd),
        enabled: active && Boolean(activeCwd),
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.toolsList({ workspace: asWorkspaceId(activeCwd as string) });
        },
    });
    return { tools: query.data?.tools ?? [], error: queryError(query.error)?.message ?? null };
}
