import type { ProviderView, WorkspaceId } from "@taco-ai/protocol";
/**
 * useProviders — 拉取指定 workspace 的内置 provider 可用性视图(providers.list)。
 *
 * 结构对齐 useWorkspaceModels:workspace 改变时自动重拉,refresh() 强制重拉
 * (settings.write 改 key 后调一下,让 configured 状态刷新)。
 *
 * pi-native:provider 全部常驻,configured 由 sidecar 按 key 存在性计算。
 */
import { useCallback, useEffect, useState } from "react";
import type { TacoClient } from "../lib/tacoClientTauri.ts";
import { useStableCallback } from "../lib/useStableCallback";
import { useRetryOnError } from "./useRetryOnError";

export interface UseProvidersResult {
    loading: boolean;
    providers: ProviderView[];
    error: Error | null;
    refresh: () => void;
}

export function useProviders(
    client: TacoClient,
    workspace: WorkspaceId | null,
    enabled = true,
): UseProvidersResult {
    const [loading, setLoading] = useState(false);
    const [providers, setProviders] = useState<ProviderView[]>([]);
    const [error, setError] = useState<Error | null>(null);
    const [refreshCount, setRefreshCount] = useState(0);
    // Stable ref — useRetryOnError stabilizes the setTimeout, preventing timer reset per render.
    const refresh = useCallback(() => setRefreshCount((n) => n + 1), []);

    const fetchProviders = useStableCallback((): (() => void) => {
        if (!enabled || !workspace) return () => {};
        let cancelled = false;
        setLoading(true);
        client
            .providersList(workspace)
            .then((res) => {
                if (cancelled) return;
                setProviders(res.providers);
                setError(null);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setError(err instanceof Error ? err : new Error(String(err)));
                // Keep previous providers on failure to avoid UI flicker.
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    });

    useEffect(() => {
        if (!enabled) return;
        if (!workspace) {
            setProviders([]);
            setError(null);
            return;
        }
        return fetchProviders();
    }, [workspace, enabled, fetchProviders]);

    useEffect(() => {
        if (refreshCount === 0) return;
        return fetchProviders();
    }, [refreshCount, fetchProviders]);

    // Auto-retry with backoff on failure — avoids permanent stall from cold-start race (RPC before sidecar ready).
    useRetryOnError(error, refresh);

    return { loading, providers, error, refresh };
}
