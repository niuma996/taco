import { asWorkspaceId, type GitInspectResult, IM_CWD_PREFIX } from "@taco-ai/protocol";
import {
    useIsMutating,
    useMutation,
    useQueries,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import type { TacoClient } from "../lib/clients/tacoClient";
import { queryError, refreshQueries, resourceQueryKey } from "../lib/queries/queryClient";
import { isLinkedWorktree } from "../lib/worktrees";

export type GitWorkspaceClient = Pick<TacoClient, "gitInspect" | "gitInit">;
const disabledClient = {};

/** Shared by the composer and Files drawer; only Git metadata is polled. */
export function useGitWorkspace(
    client: GitWorkspaceClient | undefined,
    cwd: string | null | undefined,
    active = true,
) {
    const queryClient = useQueryClient();
    const queryKey = resourceQueryKey(client ?? disabledClient, "git", cwd);
    const enabled = active && Boolean(client && cwd && !cwd.startsWith(IM_CWD_PREFIX));
    const query = useQuery({
        queryKey,
        enabled,
        retry: false,
        staleTime: 1000,
        refetchInterval: 10_000,
        refetchOnWindowFocus: "always",
        queryFn: ({ signal }): Promise<GitInspectResult> => {
            signal.throwIfAborted();
            if (!client || !cwd) throw new Error("No workspace");
            return client.gitInspect({ workspace: asWorkspaceId(cwd) });
        },
    });
    const mutationKey = [...queryKey, "init"];
    const initializing = useIsMutating({ mutationKey, exact: true }) > 0;
    const mutation = useMutation({
        mutationKey,
        mutationFn: async () => {
            if (!enabled || !client || !cwd || query.data?.status !== "not_repository") return;
            return client.gitInit({ workspace: asWorkspaceId(cwd) });
        },
        onSuccess: async (result) => {
            if (!result) return;
            await queryClient.cancelQueries({ queryKey, exact: true });
            queryClient.setQueryData(queryKey, result);
            await refreshQueries(queryClient, { queryKey, exact: true });
            if (client && cwd) {
                await refreshQueries(queryClient, {
                    queryKey: resourceQueryKey(client, "worktrees", cwd),
                    exact: true,
                });
            }
        },
    });

    return {
        data: enabled ? (query.data ?? null) : null,
        loading: enabled && query.isPending,
        refreshing: enabled && query.isFetching,
        error: enabled ? (queryError(query.error)?.message ?? null) : null,
        initializing,
        init: async () => {
            if (queryClient.isMutating({ mutationKey, exact: true })) return;
            await mutation.mutateAsync();
        },
        refresh: async () => {
            if (enabled) await refreshQueries(queryClient, { queryKey, exact: true });
        },
    };
}

/**
 * Classifies only the directories themselves. Repository-wide worktree inventories
 * stay scoped to the picker; these identity queries are cached and do not poll.
 */
export function useLinkedWorktreePaths(
    client: Pick<GitWorkspaceClient, "gitInspect"> | undefined,
    workspaces: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
    const cwds = Object.keys(workspaces).filter((cwd) => !cwd.startsWith(IM_CWD_PREFIX));
    const queries = useQueries({
        queries: cwds.map((cwd) => ({
            queryKey: resourceQueryKey(client ?? disabledClient, "git", cwd),
            enabled: Boolean(client),
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
            refetchInterval: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            queryFn: ({ signal }: { signal: AbortSignal }): Promise<GitInspectResult> => {
                signal.throwIfAborted();
                if (!client) throw new Error("No workspace client");
                return client.gitInspect({ workspace: asWorkspaceId(cwd) });
            },
        })),
    });
    return new Set(
        queries.flatMap((query, index) =>
            query.data && isLinkedWorktree(query.data) ? [cwds[index]] : [],
        ),
    );
}
