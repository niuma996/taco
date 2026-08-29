import type { ExtensionsStatusResult } from "@taco-ai/protocol";
import { useEffect, useState } from "react";
import { applyGlobalConfig, getGlobalConfig } from "../lib/globalConfig.js";
import type { TacoClient } from "../lib/clients/tacoClient.ts";
import { useAutoClearError } from "./useAutoClearError";

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
    const [extensionStatus, setExtensionStatus] = useState<ExtensionsStatusResult | null>(null);
    const [extensionLoading, setExtensionLoading] = useState(false);
    const [extensionSavingName, setExtensionSavingName] = useState<string | null>(null);
    const [extensionPendingRestart, setExtensionPendingRestart] = useState(false);
    const [extensionRestarting, setExtensionRestarting] = useState(false);
    const { error: extensionError, fail: failWith, clearError } = useAutoClearError();

    useEffect(() => {
        if (!active || !activeCwd) return;
        setExtensionLoading(true);
        clearError();
        void client
            .extensionsStatus()
            .then((r) => {
                setExtensionStatus(r);
            })
            .catch((e: unknown) => {
                failWith(e);
            })
            .finally(() => {
                setExtensionLoading(false);
            });
    }, [active, activeCwd, client, clearError, failWith]);

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
            setExtensionStatus((prev) => {
                if (!prev) return prev;
                if (nextDisabled) {
                    return {
                        ...prev,
                        loaded: prev.loaded.filter((e) => e.name !== name),
                        disabled: [...new Set([...prev.disabled, name])],
                    };
                }
                return { ...prev, disabled: prev.disabled.filter((n) => n !== name) };
            });
            setExtensionPendingRestart(true);
        } catch (e) {
            failWith(e);
        } finally {
            setExtensionSavingName(null);
        }
    };

    // Restart sidecar and refresh extension status after enabling/disabling.
    const restartForPlugins = async (): Promise<void> => {
        setExtensionRestarting(true);
        try {
            await restartSidecar();
            setExtensionPendingRestart(false);
            const r = await client.extensionsStatus();
            setExtensionStatus(r);
        } catch (e) {
            failWith(e);
        } finally {
            setExtensionRestarting(false);
        }
    };

    return {
        extensionStatus,
        extensionLoading,
        extensionError,
        extensionSavingName,
        extensionPendingRestart,
        extensionRestarting,
        toggleExtension,
        restartForPlugins,
    };
}
