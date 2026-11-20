import { asWorkspaceId, IM_CWD_PREFIX } from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TacoClient } from "../lib/clients/tacoClient";
import { queryError, refreshQueries, resourceQueryKey } from "../lib/queries/queryClient";

export type WorktreesClient = Pick<TacoClient, "worktreeList">;
const disabledClient = {};

/** Shares the current checkout's worktree inventory across management and navigation. */
export function useWorktrees(
    client: WorktreesClient | undefined,
    cwd: string | null | undefined,
    active = true,
) {
    const queryClient = useQueryClient();
    const queryKey = resourceQueryKey(client ?? disabledClient, "worktrees", cwd);
    const enabled = active && Boolean(client && cwd && !cwd.startsWith(IM_CWD_PREFIX));
    const query = useQuery({
        queryKey,
        enabled,
        retry: false,
        staleTime: 1000,
        refetchOnWindowFocus: "always",
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            if (!client || !cwd) throw new Error("No workspace");
            return client.worktreeList({ workspace: asWorkspaceId(cwd) });
        },
    });
    return {
        data: enabled ? (query.data ?? null) : null,
        loading: enabled && query.isPending,
        refreshing: enabled && query.isFetching,
        error: enabled ? (queryError(query.error)?.message ?? null) : null,
        refresh: async () => {
            if (enabled) await refreshQueries(queryClient, { queryKey, exact: true });
        },
    };
}
