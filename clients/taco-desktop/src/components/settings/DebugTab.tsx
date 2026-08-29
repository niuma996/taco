/**
 * DebugTab — Settings drawer Debug tab. One toggle:
 *  - debugMode: drives the in-memory LLM Dump panel via TACO_DEBUG_LLM_PAYLOAD=1.
 *    The toggle takes effect only after "Apply & Restart" (dispose + re-ensure).
 *
 *  A previous `llmDumpToFile` toggle (would-have-written `[taco:llm]` to
 *  `~/.taco/logs/llm-dump.log`) was removed: it had no consumer. The
 *  in-memory panel is the only dump surface; if a disk dump becomes
 *  desired later, wire it in the same pattern as debugMode (mirror to
 *  desktop.json, read at spawn, tee `[taco:llm]` lines to the file).
 */

import { useEffect, useState } from "react";
import { useAutoClearError } from "../../hooks/primitives/useAutoClearError.ts";
import { useT } from "../../i18n/useI18n.ts";
import { writeDesktopConfig } from "../../lib/desktopConfig.ts";
import {
    type GlobalConfigState,
    getGlobalConfig,
    subscribeGlobalConfig,
    writeClientSettings,
} from "../../lib/globalConfig.ts";
import { Button } from "../ui/Button.tsx";
import { Switch } from "../ui/Switch.tsx";

export interface DebugTabProps {
    /**
     * Restart trigger callback (provided by App.tsx: `disposeAll` + re-ensure
     * each workspace). Implementations may surface a transitional "restarting"
     * state via the error banner.
     */
    onRestart: () => Promise<void>;
}

export function DebugTab(props: DebugTabProps) {
    const [state, setState] = useState<GlobalConfigState>(() => getGlobalConfig());
    const [saving, setSaving] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const { error, fail, clearError } = useAutoClearError();
    const { t } = useT();

    useEffect(() => subscribeGlobalConfig(setState), []);

    const diskValue = state.client.debugMode ?? false;
    // "Restarted" flag — reset to false after a toggle writes client settings;
    // set back to true after a successful restart. Restart is rare, so the
    // simplified rule is: any disk-value change implies "restart pending";
    // the restart button clears the flag on completion.
    const [restarted, setRestarted] = useState(true);

    const setDebug = async (next: boolean) => {
        setSaving(true);
        clearError();
        try {
            await writeClientSettings({ debugMode: next });
            // Mirror to desktop.json so the Tauri host reads it at spawn time
            // (prewarm / restart / reconnect all read the disk). The localStorage
            // write above only drives the instant UI toggle; Rust can't read it.
            // Awaiting here means `restarted` only flips after disk is durable,
            // so the user's subsequent Apply & Restart always sees the new value.
            await writeDesktopConfig({ debugMode: next });
            setRestarted(false);
        } catch (e) {
            fail(e);
        } finally {
            setSaving(false);
        }
    };

    const applyAndRestart = async () => {
        setRestarting(true);
        clearError();
        try {
            await props.onRestart();
            setRestarted(true);
        } catch (e) {
            fail(e);
        } finally {
            setRestarting(false);
        }
    };

    return (
        <section className="settings-tab">
            <h3>{t("settings.tabDebug")}</h3>
            <p className="settings-tab-desc">{t("settings.debugModeDesc")}</p>
            <div className="settings-row compaction-toggle-row">
                <div className="compaction-toggle-text">
                    <span className="compaction-toggle-label">
                        {t("settings.debugModeEnabled")}
                    </span>
                    <span className="compaction-toggle-desc">
                        {t("settings.debugModeToggleDesc")}
                    </span>
                </div>
                <Switch
                    checked={diskValue}
                    disabled={saving}
                    onChange={(next) => void setDebug(next)}
                    label={t("settings.debugModeEnabled")}
                />
            </div>
            {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
            <p className="settings-tab-desc debug-restart-hint">{t("settings.restartHint")}</p>
            {!restarted && (
                <div className="settings-row">
                    <Button
                        variant="primary"
                        className="debug-restart-btn"
                        onClick={() => void applyAndRestart()}
                        disabled={restarting}
                    >
                        {restarting ? t("settings.restarting") : t("settings.applyAndRestart")}
                    </Button>
                </div>
            )}
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}
