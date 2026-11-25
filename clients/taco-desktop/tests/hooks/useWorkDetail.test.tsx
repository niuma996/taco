import type { WorkGetResult, WorkSummary } from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkDetail } from "../../src/hooks/useWorkDetail";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { invalidateClientQueries, resourceQueryKey } from "../../src/lib/queries/queryClient";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function detail(revision = 0, resultText = "Saved review"): WorkGetResult {
    const work: WorkSummary = {
        workId: "work-1",
        revision,
        kind: "subagent",
        title: "Review",
        agentType: "reviewer",
        status: "completed",
        sessionId: "parent",
        parentSessionId: "parent",
        createdAt: 1,
        updatedAt: 1,
        needsAttention: false,
    };
    return { work, resultText };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

function fakeClient() {
    const workGet = vi.fn(async (_params: { workId: string }): Promise<WorkGetResult> => detail());
    return { client: { workGet } as unknown as TacoClient, workGet };
}

describe("useWorkDetail", () => {
    it("shares one in-flight request and its result across simultaneous readers", async () => {
        const { client, workGet } = fakeClient();
        const pending = deferred<WorkGetResult>();
        workGet.mockReturnValueOnce(pending.promise);
        const options = queryWrapper();
        const one = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        const two = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        expect(one.result.current).toBeUndefined();
        expect(two.result.current).toBeUndefined();
        expect(workGet).toHaveBeenCalledExactlyOnceWith({ workId: "work-1" });
        await act(async () => pending.resolve(detail()));
        await waitFor(() => expect(two.result.current).toEqual(detail()));
        expect(one.result.current).toEqual(detail());
        expect(workGet).toHaveBeenCalledTimes(1);
        expect(
            options.queryClient.getQueryData(
                resourceQueryKey(client, "work-detail", "work-1", "0"),
            ),
        ).toEqual(detail());
    });

    it("reuses a completed revision on remount without another RPC", async () => {
        const { client, workGet } = fakeClient();
        const options = queryWrapper();
        const first = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        await waitFor(() => expect(first.result.current).toEqual(detail()));
        first.unmount();
        const second = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        expect(second.result.current).toEqual(detail());
        expect(workGet).toHaveBeenCalledTimes(1);
    });

    it("keeps a new revision isolated from a late result for the previous revision", async () => {
        const { client, workGet } = fakeClient();
        const older = deferred<WorkGetResult>();
        const newer = deferred<WorkGetResult>();
        workGet.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const options = queryWrapper();
        const view = renderHook(({ revision }) => useWorkDetail(client, "work-1", revision), {
            ...options,
            initialProps: { revision: 0 },
        });
        view.rerender({ revision: 1 });
        expect(view.result.current).toBeUndefined();
        expect(workGet).toHaveBeenCalledTimes(2);
        await act(async () => newer.resolve(detail(1, "New revision")));
        await waitFor(() => expect(view.result.current).toEqual(detail(1, "New revision")));
        await act(async () => older.resolve(detail(0, "Old revision")));
        expect(view.result.current).toEqual(detail(1, "New revision"));
        expect(
            options.queryClient.getQueryData(
                resourceQueryKey(client, "work-detail", "work-1", "0"),
            ),
        ).toBeUndefined();
    });

    it("clears the previous revision's visible result while the next revision loads", async () => {
        const { client, workGet } = fakeClient();
        const next = deferred<WorkGetResult>();
        workGet.mockResolvedValueOnce(detail()).mockReturnValueOnce(next.promise);
        const view = renderHook(({ revision }) => useWorkDetail(client, "work-1", revision), {
            ...queryWrapper(),
            initialProps: { revision: 0 },
        });
        await waitFor(() => expect(view.result.current).toEqual(detail()));
        view.rerender({ revision: 1 });
        expect(view.result.current).toBeUndefined();
        await act(async () => next.resolve(detail(1)));
        await waitFor(() => expect(view.result.current).toEqual(detail(1)));
    });

    it("isolates clients with the same Work identity even when the old client responds late", async () => {
        const first = fakeClient();
        const second = fakeClient();
        const pending = deferred<WorkGetResult>();
        first.workGet.mockReturnValueOnce(pending.promise);
        second.workGet.mockResolvedValue(detail(0, "Second client"));
        const options = queryWrapper();
        const view = renderHook(({ client }) => useWorkDetail(client, "work-1", 0), {
            ...options,
            initialProps: { client: first.client },
        });
        view.rerender({ client: second.client });
        expect(view.result.current).toBeUndefined();
        await waitFor(() => expect(view.result.current).toEqual(detail(0, "Second client")));
        await act(async () => pending.resolve(detail(0, "First client")));
        expect(view.result.current).toEqual(detail(0, "Second client"));
        expect(first.workGet).toHaveBeenCalledTimes(1);
        expect(second.workGet).toHaveBeenCalledTimes(1);
        expect(
            options.queryClient.getQueryData(
                resourceQueryKey(first.client, "work-detail", "work-1", "0"),
            ),
        ).toBeUndefined();
    });

    it("isolates different Work IDs at the same revision", async () => {
        const { client, workGet } = fakeClient();
        const older = deferred<WorkGetResult>();
        workGet.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ work: null });
        const view = renderHook(({ workId }) => useWorkDetail(client, workId, 0), {
            ...queryWrapper(),
            initialProps: { workId: "work-1" },
        });
        view.rerender({ workId: "work-2" });
        await waitFor(() => expect(view.result.current).toEqual({ work: null }));
        await act(async () => older.resolve(detail()));
        expect(view.result.current).toEqual({ work: null });
        expect(workGet).toHaveBeenLastCalledWith({ workId: "work-2" });
    });

    it.each([
        { workId: null, revision: 0 },
        { workId: undefined, revision: 0 },
        { workId: "work-1", revision: undefined },
    ])("returns undefined without requesting for $workId / $revision", ({ workId, revision }) => {
        const { client, workGet } = fakeClient();
        renderHook(() => useWorkDetail(client, workId, revision), queryWrapper());
        expect(workGet).not.toHaveBeenCalled();
    });

    it("hides cached detail when closed or when the summary loses its revision", async () => {
        const { client, workGet } = fakeClient();
        const view = renderHook(
            ({ workId, revision }: { workId: string | null; revision: number | undefined }) =>
                useWorkDetail(client, workId, revision),
            {
                ...queryWrapper(),
                initialProps: {
                    workId: "work-1" as string | null,
                    revision: 0 as number | undefined,
                },
            },
        );
        await waitFor(() => expect(view.result.current).toEqual(detail()));
        view.rerender({ workId: null, revision: 0 });
        expect(view.result.current).toBeUndefined();
        view.rerender({ workId: "work-1", revision: undefined });
        expect(view.result.current).toBeUndefined();
        view.rerender({ workId: "work-1", revision: 0 });
        expect(view.result.current).toEqual(detail());
        expect(workGet).toHaveBeenCalledTimes(1);
    });

    it("maps query errors to the existing fallback without inheriting root retries", async () => {
        const { client, workGet } = fakeClient();
        workGet.mockRejectedValue(new Error("transport gone"));
        const options = queryWrapper();
        options.queryClient.setDefaultOptions({ queries: { retry: 5, retryDelay: 0 } });
        const view = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        await waitFor(() => expect(view.result.current).toEqual({ work: null }));
        expect(workGet).toHaveBeenCalledTimes(1);
        expect(
            options.queryClient.getQueryState(
                resourceQueryKey(client, "work-detail", "work-1", "0"),
            )?.status,
        ).toBe("error");
    });

    it("refetches all active readers on root reconnect invalidation despite infinite freshness", async () => {
        const { client, workGet } = fakeClient();
        const other = fakeClient();
        const options = queryWrapper();
        workGet.mockResolvedValueOnce(detail()).mockResolvedValueOnce(detail(0, "After reconnect"));
        const one = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        const two = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        const unrelated = renderHook(() => useWorkDetail(other.client, "work-1", 0), options);
        await waitFor(() => expect(two.result.current).toEqual(detail()));
        await waitFor(() => expect(unrelated.result.current).toEqual(detail()));
        await act(async () => invalidateClientQueries(options.queryClient, client));
        await waitFor(() => expect(one.result.current).toEqual(detail(0, "After reconnect")));
        expect(two.result.current).toEqual(detail(0, "After reconnect"));
        expect(workGet).toHaveBeenCalledTimes(2);
        expect(other.workGet).toHaveBeenCalledTimes(1);
    });

    it("restarts an initial in-flight request on reconnect and discards its late answer", async () => {
        const { client, workGet } = fakeClient();
        const oldConnection = deferred<WorkGetResult>();
        workGet
            .mockReturnValueOnce(oldConnection.promise)
            .mockResolvedValueOnce(detail(0, "Reconnected"));
        const options = queryWrapper();
        const view = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        await act(async () => invalidateClientQueries(options.queryClient, client));
        await waitFor(() => expect(view.result.current).toEqual(detail(0, "Reconnected")));
        await act(async () => oldConnection.resolve(detail(0, "Old connection")));
        expect(view.result.current).toEqual(detail(0, "Reconnected"));
        expect(workGet).toHaveBeenCalledTimes(2);
    });

    it("garbage collects an inactive revision after sixty seconds", async () => {
        vi.useFakeTimers();
        const { client } = fakeClient();
        const options = queryWrapper();
        const view = renderHook(() => useWorkDetail(client, "work-1", 0), options);
        await act(async () => vi.advanceTimersByTimeAsync(0));
        expect(view.result.current).toEqual(detail());
        view.unmount();
        const key = resourceQueryKey(client, "work-detail", "work-1", "0");
        await act(async () => vi.advanceTimersByTimeAsync(59_999));
        expect(options.queryClient.getQueryData(key)).toEqual(detail());
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(options.queryClient.getQueryState(key)).toBeUndefined();
    });
});
