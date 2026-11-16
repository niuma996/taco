import type { CheckpointsListResult, CheckpointsRestoreResult } from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCheckpointsPane } from "../../src/hooks/useCheckpointsPane";
import { useManagementQuerySync } from "../../src/hooks/useManagementQuerySync";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { resourceQueryKey } from "../../src/lib/queries/queryClient";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(cleanup);

function list(id: string): CheckpointsListResult {
    return {
        enabled: true,
        checkpoints: [
            {
                id,
                sessionId: "session-a",
                createdAt: "2026-11-15T00:00:00.000Z",
                label: id,
                files: [],
            },
        ],
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

function fixture() {
    let ready!: () => void;
    const off = vi.fn();
    const checkpointsList = vi.fn(async ({ workspace }: { workspace: string }) => list(workspace));
    const checkpointsRestore = vi.fn(
        async (): Promise<CheckpointsRestoreResult> => ({
            restored: [],
            deleted: [],
            failed: [],
            conflicts: [],
            protectionId: "protection",
        }),
    );
    const client = {
        checkpointsList,
        checkpointsRestore,
        onConnectionReady: (callback: () => void) => {
            ready = callback;
            return off;
        },
    } as unknown as TacoClient;
    return { client, checkpointsList, checkpointsRestore, reconnect: () => ready(), off };
}

function setup(h = fixture(), options = queryWrapper()) {
    const notify = vi.fn();
    const view = renderHook(
        ({ cwd, active }: { cwd: string | undefined; active: boolean }) =>
            useCheckpointsPane(h.client, active, cwd, "session-a", notify),
        { ...options, initialProps: { cwd: "/a" as string | undefined, active: true } },
    );
    return { ...h, ...view, ...options, notify };
}

describe("Checkpoints queries", () => {
    it("deduplicates readers and shares manual refresh results", async () => {
        const h = fixture();
        const options = queryWrapper();
        const one = setup(h, options);
        const two = setup(h, options);
        await waitFor(() => expect(two.result.current.data).toEqual(list("/a")));
        expect(h.checkpointsList).toHaveBeenCalledTimes(1);
        h.checkpointsList.mockResolvedValue(list("refreshed"));
        act(() => one.result.current.refresh());
        await waitFor(() => expect(two.result.current.data).toEqual(list("refreshed")));
        expect(one.result.current.data).toEqual(list("refreshed"));
    });

    it("withholds previous workspace data and ignores its late response", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        const pending = deferred<CheckpointsListResult>();
        h.checkpointsList.mockReturnValueOnce(pending.promise);
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.checkpointsList).toHaveBeenCalledTimes(2));
        h.checkpointsList.mockReturnValueOnce(new Promise(() => {}));
        h.rerender({ cwd: "/b", active: true });
        expect(h.result.current.data).toBeNull();
        await act(async () => pending.resolve(list("obsolete-a")));
        expect(h.result.current.data).toBeNull();
    });

    it("does not query an inactive or missing target", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.rerender({ cwd: "/b", active: false });
        act(() => h.result.current.refresh());
        expect(h.checkpointsList).toHaveBeenCalledTimes(1);
        h.rerender({ cwd: undefined, active: true });
        expect(h.result.current.data).toBeNull();
        expect(h.result.current.loading).toBe(false);
        expect(h.result.current.error).toBeNull();
        expect(h.checkpointsList).toHaveBeenCalledTimes(1);
    });

    it("a manual refresh replaces a pending first read and ignores its late result", async () => {
        const h = fixture();
        const pending = deferred<CheckpointsListResult>();
        h.checkpointsList.mockReturnValueOnce(pending.promise).mockResolvedValue(list("refreshed"));
        const view = setup(h);
        act(() => view.result.current.refresh());
        await waitFor(() => expect(view.result.current.data).toEqual(list("refreshed")));
        await act(async () => pending.resolve(list("obsolete")));
        expect(view.result.current.data).toEqual(list("refreshed"));
    });

    it("isolates clients with the same workspace in one cache", async () => {
        const options = queryWrapper();
        const first = setup(fixture(), options);
        const other = fixture();
        other.checkpointsList.mockResolvedValue(list("other client"));
        const second = setup(other, options);
        await waitFor(() => expect(second.result.current.data).toEqual(list("other client")));
        expect(first.result.current.data).toEqual(list("/a"));
    });

    it("reconnect replaces a pending read and prevents an old result from publishing", async () => {
        const h = fixture();
        const options = queryWrapper();
        const pending = deferred<CheckpointsListResult>();
        h.checkpointsList
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(list("new connection"));
        const sync = renderHook(() => useManagementQuerySync(h.client), options);
        const view = setup(h, options);
        act(() => h.reconnect());
        await waitFor(() => expect(view.result.current.data).toEqual(list("new connection")));
        await act(async () => pending.resolve(list("old connection")));
        expect(view.result.current.data).toEqual(list("new connection"));
        sync.unmount();
        expect(h.off).toHaveBeenCalledTimes(1);
    });

    it("reports string failures and retains confirmed data until refresh succeeds", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.checkpointsList.mockRejectedValueOnce("read unavailable");
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.result.current.error).toBe("read unavailable"));
        expect(h.result.current.data).toEqual(list("/a"));
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.result.current.error).toBeNull());
    });

    it("clears the previous error while a manual refresh is in flight", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.checkpointsList.mockRejectedValueOnce("read unavailable");
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.result.current.error).toBe("read unavailable"));
        const pending = deferred<CheckpointsListResult>();
        h.checkpointsList.mockReturnValueOnce(pending.promise);
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.result.current.loading).toBe(true));
        expect(h.result.current.error).toBeNull();
        await act(async () => pending.resolve(list("/b")));
        await waitFor(() => expect(h.result.current.data).toEqual(list("/b")));
        expect(h.result.current.error).toBeNull();
    });

    it("surfaces the new failure when a manual refresh fails again", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.checkpointsList.mockRejectedValueOnce("read unavailable");
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.result.current.error).toBe("read unavailable"));
        h.checkpointsList.mockRejectedValueOnce("still unavailable");
        act(() => h.result.current.refresh());
        await waitFor(() => expect(h.result.current.error).toBe("still unavailable"));
    });
});

describe("Checkpoints restore", () => {
    for (const fails of [false, true]) {
        it(`refreshes all readers after restore ${fails ? "fails" : "succeeds"} without retrying the operation`, async () => {
            const h = fixture();
            const options = queryWrapper();
            const one = setup(h, options);
            const two = setup(h, options);
            await waitFor(() => expect(two.result.current.data).toEqual(list("/a")));
            h.checkpointsList.mockResolvedValue(list("protection"));
            if (fails) h.checkpointsRestore.mockRejectedValue(new Error("partially restored"));
            let restored: unknown;
            await act(async () => {
                restored = await one.result.current.restore("cp-a");
            });
            await waitFor(() => expect(two.result.current.data).toEqual(list("protection")));
            expect(one.result.current.data).toEqual(list("protection"));
            expect(h.checkpointsRestore).toHaveBeenCalledExactlyOnceWith({
                workspace: "/a",
                checkpointId: "cp-a",
                sessionId: "session-a",
            });
            expect(restored).toEqual(
                fails
                    ? { ok: false, reason: "partially restored" }
                    : { ok: true, protectionId: "protection" },
            );
            expect(one.result.current.restoringId).toBeNull();
            if (fails)
                expect(one.notify).toHaveBeenCalledWith("Restore failed: partially restored");
            else expect(one.notify).not.toHaveBeenCalled();
        });
    }

    it("invalidates the originating workspace when restore settles after navigation", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        const pending = deferred<CheckpointsRestoreResult>();
        h.checkpointsRestore.mockReturnValueOnce(pending.promise);
        let operation!: ReturnType<typeof h.result.current.restore>;
        act(() => {
            operation = h.result.current.restore("cp-a");
        });
        expect(h.result.current.restoringId).toBe("cp-a");
        h.rerender({ cwd: "/b", active: true });
        await waitFor(() => expect(h.result.current.data).toEqual(list("/b")));
        expect(h.result.current.restoringId).toBeNull();
        const readCount = h.checkpointsList.mock.calls.length;
        await act(async () => {
            pending.resolve({ restored: [], deleted: [], failed: [], conflicts: [] });
            await operation;
        });
        expect(h.result.current.data).toEqual(list("/b"));
        expect(h.checkpointsList).toHaveBeenCalledTimes(readCount);
        expect(
            h.queryClient.getQueryState(resourceQueryKey(h.client, "checkpoints", "/a"))
                ?.isInvalidated,
        ).toBe(true);
        h.rerender({ cwd: "/a", active: true });
        await waitFor(() => expect(h.checkpointsList).toHaveBeenCalledTimes(readCount + 1));
    });
    it("marks a hidden list stale after restore and refetches only when enabled again", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        const pending = deferred<CheckpointsRestoreResult>();
        h.checkpointsRestore.mockReturnValueOnce(pending.promise);
        let operation!: ReturnType<typeof h.result.current.restore>;
        act(() => {
            operation = h.result.current.restore("cp-a");
        });
        h.rerender({ cwd: "/a", active: false });
        h.checkpointsList.mockResolvedValue(list("protection"));
        await act(async () => {
            pending.resolve({ restored: [], deleted: [], failed: [], conflicts: [] });
            await operation;
        });
        expect(h.checkpointsList).toHaveBeenCalledTimes(1);
        expect(
            h.queryClient.getQueryState(resourceQueryKey(h.client, "checkpoints", "/a"))
                ?.isInvalidated,
        ).toBe(true);
        h.rerender({ cwd: "/a", active: true });
        await waitFor(() => expect(h.result.current.data).toEqual(list("protection")));
    });

    it("preserves restore success when the follow-up list read fails", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.checkpointsList.mockRejectedValue("refresh unavailable");
        let restored: unknown;
        await act(async () => {
            restored = await h.result.current.restore("cp-a");
        });
        expect(restored).toEqual({ ok: true, protectionId: "protection" });
        await waitFor(() => expect(h.result.current.error).toBe("refresh unavailable"));
        expect(h.result.current.data).toEqual(list("/a"));
        expect(h.checkpointsRestore).toHaveBeenCalledTimes(1);
        expect(h.notify).not.toHaveBeenCalled();
    });

    it("keeps another workspace's restore busy when an older restore completes", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        const first = deferred<CheckpointsRestoreResult>();
        const second = deferred<CheckpointsRestoreResult>();
        h.checkpointsRestore.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        let one!: ReturnType<typeof h.result.current.restore>;
        act(() => {
            one = h.result.current.restore("cp-a");
        });
        h.rerender({ cwd: "/b", active: true });
        await waitFor(() => expect(h.result.current.data).toEqual(list("/b")));
        let two!: ReturnType<typeof h.result.current.restore>;
        act(() => {
            two = h.result.current.restore("cp-b");
        });
        await act(async () => {
            first.resolve({ restored: [], deleted: [], failed: [], conflicts: [] });
            await one;
        });
        expect(h.result.current.restoringId).toBe("cp-b");
        await act(async () => {
            second.resolve({ restored: [], deleted: [], failed: [], conflicts: [] });
            await two;
        });
        expect(h.result.current.restoringId).toBeNull();
    });

    it("keeps per-file failure and conflict notifications and refreshes the protection list", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.checkpointsRestore.mockResolvedValue({
            restored: [],
            deleted: [],
            protectionId: "protection",
            failed: [{ path: "/a/broken.ts", reason: "permission denied" }],
            conflicts: [{ path: "/a/edited.ts", reason: "changed" }],
        });
        h.checkpointsList.mockResolvedValue(list("protection"));
        await act(async () => {
            await h.result.current.restore("cp-a");
        });
        await waitFor(() => expect(h.result.current.data).toEqual(list("protection")));
        expect(h.notify.mock.calls).toEqual([
            ["Restore incomplete: 1 file(s) not restored — /a/broken.ts"],
            ["Restore skipped 1 changed file(s): /a/edited.ts"],
        ]);
    });

    it("returns a failure without issuing a restore when no workspace exists", async () => {
        const h = setup();
        await waitFor(() => expect(h.result.current.data).toEqual(list("/a")));
        h.rerender({ cwd: undefined, active: true });
        await expect(h.result.current.restore("cp-a")).resolves.toEqual({
            ok: false,
            reason: "no active workspace",
        });
        expect(h.checkpointsRestore).not.toHaveBeenCalled();
    });
});
