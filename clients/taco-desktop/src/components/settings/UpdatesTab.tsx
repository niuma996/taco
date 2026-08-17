/**
 * UpdatesTab — Settings drawer "Updates" tab.
 *
 * Surfaces the desktop updater as a user-initiated check (no auto-popup
 * on cold start; the discoverability is the badge on the Settings
 * activity-rail entry). Shows:
 *   - current binary version (from tauri.app.getVersion())
 *   - last check result: "up to date" / "available: vX.Y.Z" / "failed"
 *   - Check now button that re-runs the manifest query and, if a new
 *     version is found, opens the UpdateDialog so the user can install.
 *
 * The dialog itself lives in App.tsx so it can stay mounted across
 * Settings tab switches; this tab only triggers the check + hands
 * the dialog open-state back via `onOpenDialog`.
 */

import { useEffect, useState } from "react";
import { useT } from "../../i18n/useI18n.ts";
import { getCurrentVersion } from "../../lib/updater.ts";
import { Button } from "../ui/Button.tsx";

export interface UpdatesTabProps {
    /** Currently known available update from the latest check, or null
     *  if the last check returned no update / errored. Drives both the
     *  status line and the secondary "Install" button. */
    updateAvailable: { version: string } | null;
    /** True while a check is in flight — disables the Check now button
     *  to prevent duplicate GETs against the manifest endpoint. */
    checking: boolean;
    /** Last check error message, if any. Surfaced verbatim; the plugin
     *  throws human-readable strings ("signature verification failed",
     *  "404 Not Found") so users see what's actually wrong. */
    lastError: string | null;
    /** Triggers a fresh checkForUpdate() in the parent, which then
     *  updates updateAvailable + opens the dialog if applicable. */
    onCheck: () => void;
}

/** Status line for the "Status" row — single source of truth so the
 *  parent doesn't have to recompute it. */
type Status = "checking" | "upToDate" | "available" | "error";

export function UpdatesTab(props: UpdatesTabProps) {
    const { t } = useT();
    const [currentVersion, setCurrentVersion] = useState<string | null>(null);

    useEffect(() => {
        // getVersion() throws in dev (no Tauri runtime); swallow and
        // render the row as "—" so the tab doesn't crash the Settings
        // view for non-desktop users.
        void getCurrentVersion()
            .then(setCurrentVersion)
            .catch(() => setCurrentVersion(null));
    }, []);

    const status: Status = props.checking
        ? "checking"
        : props.lastError
          ? "error"
          : props.updateAvailable
            ? "available"
            : "upToDate";

    const statusText = (() => {
        switch (status) {
            case "checking":
                return t("settings.updates.statusChecking");
            case "error":
                return t("settings.updates.statusError", { error: props.lastError ?? "" });
            case "available":
                return t("settings.updates.statusAvailable", {
                    version: props.updateAvailable?.version ?? "",
                });
            case "upToDate":
                return t("settings.updates.statusUpToDate");
        }
    })();

    return (
        <div className="settings-tab">
            <h3>{t("settings.updates.title")}</h3>
            <p className="settings-tab-desc">{t("settings.updates.desc")}</p>
            <div className="settings-row">
                <div className="settings-row-label">{t("settings.updates.currentVersion")}</div>
                <div className="settings-row-value">{currentVersion ?? "—"}</div>
            </div>
            <div className="settings-row">
                <div className="settings-row-label">{t("settings.updates.status")}</div>
                <div className="settings-row-value" data-status={status}>
                    {statusText}
                </div>
            </div>
            <div className="settings-row-block">
                <Button variant="primary" disabled={props.checking} onClick={props.onCheck}>
                    {t("settings.updates.checkNow")}
                </Button>
            </div>
        </div>
    );
}
