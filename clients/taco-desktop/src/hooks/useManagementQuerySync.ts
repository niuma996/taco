import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { TacoClient } from "../lib/clients/tacoClient";
import { invalidateClientQueries } from "../lib/queries/queryClient";

/** One subscription per application; every cached management resource shares it. */
export function useManagementQuerySync(client: TacoClient) {
    const queryClient = useQueryClient();
    useEffect(
        () =>
            client.onConnectionReady(() => {
                void invalidateClientQueries(queryClient, client);
            }),
        [client, queryClient],
    );
}
