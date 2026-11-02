import { strict as assert } from "node:assert";
import type { WorkListResult, WorkRetryDeliveryResult, WorkSummary } from "@taco-ai/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { useWorkOverview, WORK_OVERVIEW_COALESCE_MS } from "../../src/hooks/useWorkOverview";
import type { TacoClient } from "../../src/lib/clients/tacoClient.ts";
import { onWorkChangedEvent } from "../../src/lib/workEvents.ts";

function summary(id: string, status: WorkSummary["status"] = "completed"): WorkSummary {
    return {
        workId: id,
        revision: 1,
        kind: "subagent",
        title: id,
        agentType: "explorer",
        status,
        createdAt: 1,
        updatedAt: 1,
        parentSessionId: "p",
        childSessionId: `c-${id}`,
        needsAttention: false,
    };
}

function page(instanceId: string, terminal: WorkSummary[] = []): WorkListResult {
    return { instanceId, active: [], terminal };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

function fakeClient() {
    const workList = vi.fn(async (): Promise<WorkListResult> => page("inst-1"));
    let ready: (() => void) | undefined;
    const onConnectionReady = vi.fn((handler: () => void) => {
        ready = handler;
        return () => {
            ready = undefined;
        };
    });
    const workRetryDelivery = vi.fn(
        async (): Promise<WorkRetryDeliveryResult> => ({ outcome: "accepted" }),
    );
    return {
        client: { workList, workRetryDelivery, onConnectionReady } as unknown as TacoClient,
        workList,
        workRetryDelivery,
        onConnectionReady,
        fireReady: () => ready?.(),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("useWorkOverview", () => {
    it("does not fetch while the pane is closed", () => {
        const { client, workList } = fakeClient();
        renderHook(() => useWorkOverview(client, false, "/ws"));
        assert.equal(workList.mock.calls.length, 0);
    });

    it("fetches on activation and stores the grouped result", async () => {
        const { client, workList } = fakeClient();
        const { result, rerender } = renderHook(
            ({ active }) => useWorkOverview(client, active, "/ws"),
            { initialProps: { active: false } },
        );
        act(() => rerender({ active: true }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        assert.equal(workList.mock.calls.length, 1);
        assert.equal(result.current.state.loaded, true);
    });

    it("refetches after the coalescing window when a push names a Work", async () => {
        const { client, workList } = fakeClient();
        const { result } = renderHook(() => useWorkOverview(client, true, "/ws"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        assert.equal(workList.mock.calls.length, 1);

        act(() => {
            onWorkChangedEvent({ instanceId: "inst-1", workIds: ["w-1"] });
            onWorkChangedEvent({ instanceId: "inst-1", workIds: ["w-2"] });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(WORK_OVERVIEW_COALESCE_MS + 10);
        });
        assert.equal(workList.mock.calls.length, 2, "a burst produced one refetch");
        assert.equal(result.current.state.loaded, true);
    });

    it("refetches when the daemon answers initialize again, even for the same instance", async () => {
        const { client, workList, fireReady } = fakeClient();
        renderHook(() => useWorkOverview(client, true, "/ws"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        assert.equal(workList.mock.calls.length, 1);

        act(() => fireReady());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(WORK_OVERVIEW_COALESCE_MS + 10);
        });
        assert.equal(
            workList.mock.calls.length,
            2,
            "a reconnect the epoch guard misses still refetches",
        );
    });

    it("keeps the newest answer when an older request lands after a reconnect", async () => {
        const { client, workList, fireReady } = fakeClient();
        const older = deferred<WorkListResult>();
        const newer = deferred<WorkListResult>();
        workList.mockImplementationOnce(() => older.promise);
        workList.mockImplementationOnce(() => newer.promise);

        const { result, rerender } = renderHook(
            ({ active }) => useWorkOverview(client, active, "/ws"),
            { initialProps: { active: true } },
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        assert.equal(workList.mock.calls.length, 1);

        // The reconnect retires the in-flight request and starts a new one.
        act(() => fireReady());
        await act(async () => {
            await vi.advanceTimersByTimeAsync(WORK_OVERVIEW_COALESCE_MS + 10);
        });
        assert.equal(workList.mock.calls.length, 2);

        await act(async () => {
            newer.resolve(page("inst-2", [summary("fresh")]));
            await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
            older.resolve(page("inst-1", [summary("stale")]));
            await vi.advanceTimersByTimeAsync(0);
        });

        assert.equal(result.current.state.instanceId, "inst-2");
        assert.deepEqual(
            result.current.state.groups.finished.map((w) => w.workId),
            ["fresh"],
        );
        rerender({ active: true });
    });

    it("re-sends a delivery on request and refreshes", async () => {
        const { client, workRetryDelivery, workList } = fakeClient();
        const { result } = renderHook(() => useWorkOverview(client, true, "/ws"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
            await result.current.retryDelivery("w-1");
        });
        assert.deepEqual(workRetryDelivery.mock.calls[0], [{ workId: "w-1" }]);
        assert.equal(workList.mock.calls.length, 2, "the pane looks again after a re-send");
    });

    it("shows a failure when the delivery cannot be re-sent", async () => {
        const { client, workRetryDelivery } = fakeClient();
        workRetryDelivery.mockResolvedValueOnce({ outcome: "not_retryable" });
        const { result } = renderHook(() => useWorkOverview(client, true, "/ws"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
            await result.current.retryDelivery("w-1");
        });
        assert.match(result.current.error ?? "", /not retryable/);
    });
});
