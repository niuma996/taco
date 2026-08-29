/**
 * Mount-time setup effects for the App shell.
 *
 *  - initFromStorage: run once on mount (calls sidecar.start for persisted workspaces)
 *  - desktopConfig: load for the onboarding gate
 *  - globalConfig subscription: keep global config reactive without a hard reload
 *  - updateCheck: silent auto-check in prod; skipped in dev (avoids GitHub API spam)
 *  - FS scope: grant tauri-plugin-fs file access for each newly activated workspace
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { type DesktopConfig, readDesktopConfig } from "../lib/desktopConfig.js";
import { getGlobalConfig, subscribeGlobalConfig } from "../lib/globalConfig";
import { checkForUpdate } from "../lib/updater.ts";

export interface UseAppLifecycleResult {
    desktopConfig: DesktopConfig | null;
    /** Used by OnboardingModal to record completion. */
    setDesktopConfig: React.Dispatch<React.SetStateAction<DesktopConfig | null>>;
    /** Reactive global config — kept in sync with Settings changes without a hard reload. */
    globalConfigState: ReturnType<typeof getGlobalConfig>;
    /** Triggers a manual update check (Check now button in Settings). */
    runUpdateCheck: () => void;
    updateStatus: {
        checking: boolean;
        available: { version: string } | null;
        error: string | null;
    };
    updateDialog: { open: boolean; version?: string };
    openUpdateDialog: (version: string) => void;
    closeUpdateDialog: () => void;
}

export function useAppLifecycle(
    activeCwd: string | undefined,
    initFromStorage: () => Promise<void>,
): UseAppLifecycleResult {
    // ── initFromStorage: run once on mount ──────────────────────────────────────
    useEffect(() => {
        void initFromStorage();
    }, [initFromStorage]);

    // ── desktop config for onboarding gate ───────────────────────────────────────
    const [desktopConfig, setDesktopConfig] = useState<DesktopConfig | null>(null);
    useEffect(() => {
        readDesktopConfig()
            .then(setDesktopConfig)
            .catch((err) => {
                console.error("[taco] failed to load desktop config", err);
                setDesktopConfig({});
            });
    }, []);

    // ── global config: keep Settings drawer changes reactive ───────────────────────
    const [globalConfigState, setGlobalConfigState] = useState(() => getGlobalConfig());
    useEffect(() => subscribeGlobalConfig(setGlobalConfigState), []);

    // ── update check ─────────────────────────────────────────────────────────────
    const [updateStatus, setUpdateStatus] = useState({
        checking: false,
        available: null as { version: string } | null,
        error: null as string | null,
    });
    const [updateDialog, setUpdateDialog] = useState<{ open: boolean; version?: string }>({
        open: false,
    });

    const runUpdateCheck = useCallback(() => {
        setUpdateStatus((s) => ({ ...s, checking: true, error: null }));
        void (async () => {
            const status = await checkForUpdate();
            if (status.state === "available" && status.version) {
                setUpdateStatus({
                    checking: false,
                    available: { version: status.version },
                    error: null,
                });
                setUpdateDialog({ open: true, version: status.version });
            } else if (status.state === "error") {
                setUpdateStatus({
                    checking: false,
                    available: null,
                    error: status.error ?? "unknown error",
                });
            } else {
                setUpdateStatus({ checking: false, available: null, error: null });
            }
        })();
    }, []);

    // Silent auto-check on mount. Skipped in dev (manifest endpoint 404s under hot-reload).
    useEffect(() => {
        if (import.meta.env.DEV) return;
        runUpdateCheck();
    }, [runUpdateCheck]);

    // ── FS scope: grant file access per active workspace ────────────────────────
    useEffect(() => {
        if (!activeCwd) return;
        void tauriInvoke("set_fs_scope", { path: activeCwd }).catch((e: unknown) => {
            console.warn("[taco] set_fs_scope failed:", e);
        });
    }, [activeCwd]);

    return {
        desktopConfig,
        setDesktopConfig,
        globalConfigState,
        runUpdateCheck,
        updateStatus,
        updateDialog,
        openUpdateDialog: (version) => setUpdateDialog({ open: true, version }),
        closeUpdateDialog: () => setUpdateDialog({ open: false }),
    };
}
