import type { Job } from "@taco-ai/protocol";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { createJobsClient } from "../clients/jobsClient";
import type { TacoClient } from "../clients/tacoClient";
import { refreshQueries, resourceQueryKey } from "./queryClient";

export function jobsListQuery(client: TacoClient) {
    return queryOptions({
        queryKey: resourceQueryKey(client, "jobs", "list"),
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return createJobsClient(client).list();
        },
    });
}

export function jobQuery(client: TacoClient, id: string) {
    return queryOptions({
        queryKey: resourceQueryKey(client, "jobs", "get", id),
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return createJobsClient(client).get(id);
        },
    });
}

export function jobHistoryQuery(client: TacoClient, id: string) {
    return queryOptions({
        queryKey: resourceQueryKey(client, "jobs", "history", id),
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return createJobsClient(client).history(id);
        },
    });
}

export function jobWorkQuery(client: TacoClient, id: string) {
    return queryOptions({
        queryKey: resourceQueryKey(client, "jobs", "work", id),
        retry: false,
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.workList({ jobId: id, limit: 200 });
        },
    });
}

/** Job mutations affect both the schedule table and the memory settings reader. */
export function refreshJobs(queryClient: QueryClient, client: TacoClient) {
    return refreshQueries(queryClient, { queryKey: resourceQueryKey(client, "jobs") });
}

/** Publish the confirmed write before refetch, so failed reads cannot undo it. */
export async function publishJob(queryClient: QueryClient, client: TacoClient, job: Job) {
    const detailKey = jobQuery(client, job.id).queryKey;
    const listKey = jobsListQuery(client).queryKey;
    await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: listKey }),
    ]);
    queryClient.setQueryData(detailKey, job);
    queryClient.setQueryData(listKey, (previous) =>
        previous?.map((entry) => (entry.id === job.id ? job : entry)),
    );
}
