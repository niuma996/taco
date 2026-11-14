import type { WorkGetResult } from "@taco-ai/protocol";
import { useQuery } from "@tanstack/react-query";
import type { TacoClient } from "../lib/clients/tacoClient";
import { resourceQueryKey } from "../lib/queries/queryClient";

export function useWorkDetail(
    client: TacoClient,
    workId: string | null | undefined,
    revision: number | undefined,
): WorkGetResult | undefined {
    const enabled = workId != null && revision !== undefined;
    const detail = useQuery({
        queryKey: resourceQueryKey(client, "work-detail", workId, revision?.toString()),
        enabled,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.workGet({ workId: workId as string });
        },
        retry: false,
        staleTime: Infinity,
        gcTime: 60_000,
    });
    if (!enabled) return undefined;
    return detail.isError ? { work: null } : detail.data;
}
