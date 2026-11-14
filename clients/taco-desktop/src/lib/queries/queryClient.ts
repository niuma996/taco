import { QueryClient, type QueryFilters } from "@tanstack/react-query";
import type { TacoClient } from "../clients/tacoClient";

export function createDesktopQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: {
                networkMode: "always",
                retry: 5,
                retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
                refetchOnWindowFocus: false,
                refetchOnReconnect: false,
            },
            mutations: { networkMode: "always", retry: false },
        },
    });
}

const identities = new WeakMap<TacoClient, number>();
let nextIdentity = 0;
export function clientQueryKey(client: TacoClient) {
    let identity = identities.get(client);
    if (identity === undefined) {
        identity = ++nextIdentity;
        identities.set(client, identity);
    }
    return ["sidecar", identity] as const;
}

export function resourceQueryKey(
    client: TacoClient,
    resource: string,
    ...identity: (string | null | undefined)[]
) {
    return [...clientQueryKey(client), resource, ...identity] as const;
}

/** Invalidate after cancellation, including a first fetch that has no cached data. */
export async function refreshQueries(queryClient: QueryClient, filters: QueryFilters) {
    await queryClient.cancelQueries(filters);
    await queryClient.invalidateQueries(filters, { cancelRefetch: false });
}

export function invalidateClientQueries(queryClient: QueryClient, client: TacoClient) {
    return refreshQueries(queryClient, { queryKey: clientQueryKey(client) });
}

export async function invalidateCatalogQueries(
    queryClient: QueryClient,
    client: TacoClient,
    workspace?: string,
) {
    const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
            query.queryKey[0] === "sidecar" &&
            query.queryKey[1] === clientQueryKey(client)[1] &&
            (query.queryKey[2] === "providers" || query.queryKey[2] === "models") &&
            (workspace === undefined || query.queryKey[3] === workspace),
    };
    await refreshQueries(queryClient, filters);
}

export const catalogQueryPolicy = {
    staleTime: 30_000,
};

/** RPC transports can reject strings as well as Error objects. */
export function queryError(error: unknown): Error | null {
    return error == null ? null : error instanceof Error ? error : new Error(String(error));
}
