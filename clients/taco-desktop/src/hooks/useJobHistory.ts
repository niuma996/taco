import type { WorkSummary } from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { TacoClient } from "../lib/clients/tacoClient";
import { jobHistoryQuery, jobWorkQuery } from "../lib/queries/jobsQueries";
import { queryError, refreshQueries } from "../lib/queries/queryClient";
import { subscribeWorkChanged } from "../lib/workEvents";

/** Built-in fires and pre-session failures need polling even when no Work push arrives. */
export const JOB_HISTORY_POLL_MS = 10_000;

export function useJobHistory(client: TacoClient, jobId: string | undefined) {
    const queryClient = useQueryClient();
    const enabled = jobId !== undefined;
    const history = useQuery({
        ...jobHistoryQuery(client, jobId ?? ""),
        enabled,
        refetchInterval: JOB_HISTORY_POLL_MS,
        refetchIntervalInBackground: true,
    });
    const work = useQuery({
        ...jobWorkQuery(client, jobId ?? ""),
        enabled,
        refetchInterval: JOB_HISTORY_POLL_MS,
        refetchIntervalInBackground: true,
    });
    useEffect(() => {
        if (jobId === undefined) return;
        return subscribeWorkChanged(() => {
            void Promise.all([
                refreshQueries(queryClient, { queryKey: jobHistoryQuery(client, jobId).queryKey }),
                refreshQueries(queryClient, { queryKey: jobWorkQuery(client, jobId).queryKey }),
            ]);
        });
    }, [client, jobId, queryClient]);
    const works = useMemo(() => {
        const byId = new Map<string, WorkSummary>();
        for (const entry of [...(work.data?.active ?? []), ...(work.data?.terminal ?? [])])
            byId.set(entry.workId, entry);
        return byId;
    }, [work.data]);
    return {
        history:
            enabled && history.data !== undefined && work.data !== undefined
                ? (history.data ?? [])
                : null,
        works,
        error: queryError(history.error ?? work.error)?.message ?? null,
    };
}
