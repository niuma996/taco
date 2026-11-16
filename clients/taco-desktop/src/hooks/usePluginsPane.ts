import type { ExtensionsStatusResult } from "@taco-ai/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { applyGlobalConfig, getGlobalConfig } from "../lib/globalConfig.js";
import { queryError, refreshQueries, resourceQueryKey } from "../lib/queries/queryClient";
import { useAutoClearError } from "./primitives/useAutoClearError";

export interface UsePluginsPaneResult {
    extensionStatus: ExtensionsStatusResult | null;
    extensionLoading: boolean;
    extensionError: string | null;
    extensionSavingName: string | null;
    extensionPendingRestart: boolean;
    extensionRestarting: boolean;
    toggleExtension: (name: string, nextDisabled: boolean) => Promise<void>;
    restartForPlugins: () => Promise<void>;
}

/** Loads extension status + manages enable/disable + restart for the plugins pane. */
export function usePluginsPane(
    client: TacoClient,
    active: boolean,
    activeCwd: string | undefined,
    restartSidecar: () => Promise<void>,
): UsePluginsPaneResult {
    const queryClient = useQueryClient();
    const queryKey = resourceQueryKey(client, "plugins");
    const status = useQuery({
        retry: false,
        queryKey,
        enabled: active && Boolean(activeCwd),
        queryFn: ({ signal }) => {
            signal.throwIfAborted();
            return client.extensionsStatus();
        },
    });
    const [extensionSavingName, setExtensionSavingName] = useState<string | null>(null);
    const [extensionRestarting, setExtensionRestarting] = useState(false);
    const { error: extensionError, fail: failWith, clearError } = useAutoClearError();

    // Toggle an extension's disabled state. Writes disabledExtensions to taco.json,
    // takes effect after restart.
    const toggleExtension = async (name: string, nextDisabled: boolean): Promise<void> => {
        setExtensionSavingName(name);
        clearError();
        try {
            const current = getGlobalConfig().global.disabledExtensions ?? [];
            const next = nextDisabled
                ? [...new Set([...current, name])]
                : current.filter((n) => n !== name);
            const result = await client.settingsWrite({ global: { disabledExtensions: next } });
            applyGlobalConfig(result.global);
            await refreshQueries(queryClient, { queryKey });
        } catch (e) {
            failWith(e);
        } finally {
            setExtensionSavingName(null);
        }
    };

    // Restart the background service and refresh extension status after enabling/disabling.
    const restartForPlugins = async (): Promise<void> => {
        setExtensionRestarting(true);
        try {
            await restartSidecar();
            await refreshQueries(queryClient, { queryKey });
        } catch (e) {
            failWith(e);
        } finally {
            setExtensionRestarting(false);
        }
    };

    return {
        extensionStatus: status.data ?? null,
        extensionLoading: status.isFetching,
        extensionError: extensionError ?? queryError(status.error)?.message ?? null,
        extensionSavingName,
        extensionPendingRestart: Object.values(status.data?.pendingRestart ?? {}).some(
            (names) => names.length > 0,
        ),
        extensionRestarting,
        toggleExtension,
        restartForPlugins,
    };
}
