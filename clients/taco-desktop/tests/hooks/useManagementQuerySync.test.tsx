import { asWorkspaceId } from "@taco-ai/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useManagementQuerySync } from "../../src/hooks/useManagementQuerySync";
import { useProviders } from "../../src/hooks/useProviders";
import type { TacoClient } from "../../src/lib/clients/tacoClient";
import {
    createDesktopQueryClient,
    invalidateCatalogQueries,
} from "../../src/lib/queries/queryClient";
import { queryWrapper } from "../helpers/queryWrapper";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});
const A = asWorkspaceId("/a");
const B = asWorkspaceId("/b");
const result = (id: string) => ({
    providers: [{ id, name: id, configured: true, custom: false, models: [] }],
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

describe("management query lifecycle", () => {
    it("marks hidden catalogs stale and refreshes them when enabled again", async () => {
        const providersList = vi.fn(async ({ workspace }: { workspace: string }) =>
            result(workspace),
        );
        const client = { providersList } as unknown as TacoClient;
        const options = queryWrapper();
        const view = renderHook(
            ({ workspace, active }) => useProviders(client, workspace, active),
            { ...options, initialProps: { workspace: A, active: true } },
        );
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe(A));
        view.rerender({ workspace: B, active: true });
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe(B));
        providersList.mockResolvedValue(result("updated A"));
        await act(async () => invalidateCatalogQueries(options.queryClient, client, A));
        expect(providersList).toHaveBeenCalledTimes(2);
        view.rerender({ workspace: A, active: true });
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe("updated A"));
    });

    it("reconnect cancels an older generation before refetch and rejects its late result", async () => {
        let ready!: () => void;
        const old = deferred<ReturnType<typeof result>>();
        const off = vi.fn();
        const providersList = vi
            .fn()
            .mockReturnValueOnce(old.promise)
            .mockResolvedValue(result("new generation"));
        const client = {
            providersList,
            onConnectionReady: (callback: () => void) => {
                ready = callback;
                return off;
            },
        } as unknown as TacoClient;
        const options = queryWrapper();
        const sync = renderHook(() => useManagementQuerySync(client), options);
        const view = renderHook(() => useProviders(client, A), options);
        await waitFor(() => expect(providersList).toHaveBeenCalledTimes(1));
        act(() => ready());
        await waitFor(() => expect(view.result.current.providers[0]?.id).toBe("new generation"));
        await act(async () => old.resolve(result("obsolete")));
        expect(view.result.current.providers[0]?.id).toBe("new generation");
        sync.unmount();
        expect(off).toHaveBeenCalledTimes(1);
    });

    it("uses bounded retries while ignoring browser network and focus events", async () => {
        vi.useFakeTimers();
        const cache = createDesktopQueryClient();
        const defaults = cache.getDefaultOptions().queries;
        expect(defaults?.refetchOnWindowFocus).toBe(false);
        expect(defaults?.refetchOnReconnect).toBe(false);
        expect(defaults?.networkMode).toBe("always");
        const queryFn = vi.fn(async () => {
            throw new Error("unavailable");
        });
        const request = cache
            .fetchQuery({ queryKey: ["retry"], queryFn })
            .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(23_001);
        expect(queryFn).toHaveBeenCalledTimes(6);
        expect(await request).toBeInstanceOf(Error);
        cache.clear();
    });
});
