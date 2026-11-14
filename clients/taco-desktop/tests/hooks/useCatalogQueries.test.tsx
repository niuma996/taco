import { asWorkspaceId } from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviders } from "../../src/hooks/useProviders";
import { useWorkspaceModels } from "../../src/hooks/useWorkspaceModels";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(cleanup);
const A = asWorkspaceId("/repo-a");
const B = asWorkspaceId("/repo-b");
const provider = (name: string) => ({
    id: name,
    name,
    configured: true,
    custom: false,
    models: [],
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
function makeClient() {
    const providersList = vi.fn(async ({ workspace }: { workspace: string }) => ({
        providers: [provider(workspace)],
    }));
    const sessionListModels = vi.fn(async ({ workspace }: { workspace: string }) => ({
        models: [{ id: workspace, provider: "test" }],
    }));
    return {
        client: { providersList, sessionListModels } as unknown as TacoClient,
        providersList,
        sessionListModels,
    };
}

describe("catalog queries", () => {
    it("deduplicates simultaneous provider readers and shares their refresh", async () => {
        const { client, providersList } = makeClient();
        const options = queryWrapper();
        const first = renderHook(() => useProviders(client, A), options);
        const second = renderHook(() => useProviders(client, A), options);
        await waitFor(() => expect(second.result.current.providers).toHaveLength(1));
        expect(providersList).toHaveBeenCalledTimes(1);
        providersList.mockResolvedValue({ providers: [provider("updated")] });
        act(() => first.result.current.refresh());
        await waitFor(() => expect(second.result.current.providers[0]?.id).toBe("updated"));
        expect(first.result.current.providers[0]?.id).toBe("updated");
    });

    it("deduplicates model readers and reuses a fresh cache after remount", async () => {
        const { client, sessionListModels } = makeClient();
        const options = queryWrapper();
        const one = renderHook(() => useWorkspaceModels(client, A), options);
        const two = renderHook(() => useWorkspaceModels(client, A), options);
        await waitFor(() => expect(two.result.current.options).toHaveLength(1));
        one.unmount();
        two.unmount();
        const again = renderHook(() => useWorkspaceModels(client, A), options);
        await waitFor(() => expect(again.result.current.options).toHaveLength(1));
        expect(sessionListModels).toHaveBeenCalledTimes(1);
    });

    it("deduplicates simultaneous refresh requests from two subscribers", async () => {
        const { client, providersList } = makeClient();
        const options = queryWrapper();
        const one = renderHook(() => useProviders(client, A), options);
        const two = renderHook(() => useProviders(client, A), options);
        await waitFor(() => expect(two.result.current.providers).toHaveLength(1));
        const pending = deferred<Awaited<ReturnType<typeof providersList>>>();
        providersList.mockReturnValue(pending.promise);
        act(() => {
            one.result.current.refresh();
            two.result.current.refresh();
        });
        await waitFor(() => expect(providersList).toHaveBeenCalledTimes(2));
        await act(async () => pending.resolve({ providers: [provider("shared update")] }));
        await waitFor(() => expect(two.result.current.providers[0]?.id).toBe("shared update"));
        expect(one.result.current.providers[0]?.id).toBe("shared update");
    });

    it("never displays the previous workspace while the next workspace loads", async () => {
        const { client, providersList } = makeClient();
        const next = deferred<Awaited<ReturnType<typeof providersList>>>();
        const view = renderHook(({ workspace }) => useProviders(client, workspace), {
            ...queryWrapper(),
            initialProps: { workspace: A },
        });
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe(A));
        providersList.mockReturnValueOnce(next.promise);
        view.rerender({ workspace: B });
        expect(view.result.current.providers).toEqual([]);
        await act(async () => next.resolve({ providers: [provider(B)] }));
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe(B));
    });

    it("isolates two clients with the same workspace inside one query cache", async () => {
        const one = makeClient();
        const two = makeClient();
        two.providersList.mockResolvedValue({ providers: [provider("second-client")] });
        const options = queryWrapper();
        const first = renderHook(() => useProviders(one.client, A), options);
        const second = renderHook(() => useProviders(two.client, A), options);
        await waitFor(() => expect(second.result.current.providers[0]?.id).toBe("second-client"));
        expect(first.result.current.providers[0]?.id).toBe(A);
    });

    it("clears a missing target and does not fetch or refresh disabled queries", async () => {
        const { client, providersList } = makeClient();
        const view = renderHook(
            ({ workspace, enabled }) => useProviders(client, workspace, enabled),
            {
                ...queryWrapper(),
                initialProps: { workspace: A as typeof A | null, enabled: false },
            },
        );
        act(() => view.result.current.refresh());
        expect(providersList).not.toHaveBeenCalled();
        view.rerender({ workspace: A, enabled: true });
        await waitFor(() => expect(view.result.current.providers).toHaveLength(1));
        view.rerender({ workspace: null, enabled: true });
        expect(view.result.current.providers).toEqual([]);
        expect(view.result.current.loading).toBe(false);
        expect(view.result.current.error).toBeNull();
    });

    it("refresh replaces an in-flight first read and ignores its late result", async () => {
        const { client, providersList } = makeClient();
        const old = deferred<Awaited<ReturnType<typeof providersList>>>();
        providersList
            .mockReturnValueOnce(old.promise)
            .mockResolvedValue({ providers: [provider("fresh")] });
        const view = renderHook(() => useProviders(client, A), queryWrapper());
        await waitFor(() => expect(providersList).toHaveBeenCalledTimes(1));
        act(() => view.result.current.refresh());
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe("fresh"));
        await act(async () => old.resolve({ providers: [provider("obsolete")] }));
        expect(view.result.current.providers[0]?.id).toBe("fresh");
    });

    it("retains successful data when a refresh fails", async () => {
        const { client, providersList } = makeClient();
        const view = renderHook(() => useProviders(client, A), queryWrapper());
        await waitFor(() => expect(view.result.current.providers).toHaveLength(1));
        providersList.mockRejectedValue(new Error("temporarily unavailable"));
        act(() => view.result.current.refresh());
        await waitFor(() =>
            expect(view.result.current.error?.message).toBe("temporarily unavailable"),
        );
        expect(view.result.current.providers[0]?.id).toBe(A);
    });
    it("normalizes a non-Error RPC rejection for the existing hook API", async () => {
        const { client, providersList } = makeClient();
        providersList.mockRejectedValue("transport unavailable");
        const view = renderHook(() => useProviders(client, A), queryWrapper());
        await waitFor(() => expect(view.result.current.error).toBeTruthy());
        expect(view.result.current.error).toBeInstanceOf(Error);
        expect(view.result.current.error?.message).toBe("transport unavailable");
    });
});
