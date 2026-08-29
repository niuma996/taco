/**
 * DebugTab — Settings drawer Debug tab. Two independent toggles:
 *  - debugMode: drives the in-memory LLM Dump panel via TACO_DEBUG_LLM_PAYLOAD=1.
 *  - llmDumpToFile: additionally persists `[taco:llm]` lines to
 *    `$TACO_HOME/logs/llm-dump.log`. Kept separate from debugMode because
 *    the in-memory panel is benign while the disk write leaves plaintext
 *    conversation in the user's home dir.
 * Both take effect only after "Apply & Restart" (dispose + re-ensure).
 */

import { useEffect, useState } from "react";
import { useAutoClearError } from "../../hooks/primitives/useAutoClearError.ts";
import { useT } from "../../i18n/useI18n.ts";
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
    const llmDumpToFile = state.client.llmDumpToFile ?? false;
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
            setRestarted(false);
        } catch (e) {
            fail(e);
        } finally {
            setSaving(false);
        }
    };

    const setLlmDumpToFile = async (next: boolean) => {
        setSaving(true);
        clearError();
        try {
            await writeClientSettings({ llmDumpToFile: next });
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
            <div className="settings-row compaction-toggle-row">
                <div className="compaction-toggle-text">
                    <span className="compaction-toggle-label">
                        {t("settings.llmDumpToFileEnabled")}
                    </span>
                    <span className="compaction-toggle-desc">
                        {t("settings.llmDumpToFileDesc")}
                    </span>
                </div>
                <Switch
                    checked={llmDumpToFile}
                    disabled={saving || !diskValue}
                    onChange={(next) => void setLlmDumpToFile(next)}
                    label={t("settings.llmDumpToFileEnabled")}
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
