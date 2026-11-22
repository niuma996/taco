import { asWorkspaceId, IM_CWD_PREFIX } from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient";
import { queryError, refreshQueries, resourceQueryKey } from "../lib/queries/queryClient";
import { mainWorktreePath } from "../lib/worktrees";

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

/** Keeps the session header on the owning checkout while its worktree changes. */
export function useOwningWorkspaceCwd(client: WorktreesClient | undefined, cwd: string): string {
    const localCwd = cwd && !cwd.startsWith(IM_CWD_PREFIX) ? cwd : null;
    const inventory = useWorktrees(client, localCwd);
    const [owningCwd, setOwningCwd] = useState(cwd);
    const data = inventory.data;
    const error = inventory.error;
    useEffect(() => {
        if (!localCwd) {
            setOwningCwd(cwd);
            return;
        }
        if (data?.status === "repository" && !data.repository.isBare) {
            const main = mainWorktreePath(data);
            if (main) setOwningCwd(main);
            return;
        }
        if (data || error) setOwningCwd(cwd);
    }, [cwd, localCwd, data, error]);
    return owningCwd;
}
