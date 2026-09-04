/**
 * DebugTab — Settings drawer Debug tab. Two toggles:
 *  - debugMode: drives the in-memory LLM Dump panel via TACO_DEBUG_LLM_PAYLOAD=1.
 *    The toggle takes effect only after "Apply & Restart" (dispose + re-ensure).
 *  - llmDumpToFile: second opt-in that also appends the same `[taco:llm]`
 *    lines to `~/.taco/logs/llm-dump.log` (owner-only, 10 MiB rotation × 3
 *    retained). Hidden unless `debugMode` is on — without debugMode there
 *    are no `[taco:llm]` lines to tee. Same restart gate as debugMode.
 *
 * The on-disk `[taco:llm]` mirror lives in `~/.taco/desktop.json` so the
 * Rust host can read it at spawn time without crossing the WebView
 * boundary. Rust applies the filter in its stderr reader — the sidecar
 * is unaware of this toggle.
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

    const diskDebug = state.client.debugMode ?? false;
    const diskLlmDump = state.client.llmDumpToFile ?? false;
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

    const setLlmDump = async (next: boolean) => {
        setSaving(true);
        clearError();
        try {
            await writeClientSettings({ llmDumpToFile: next });
            // Mirror to desktop.json — same reason as debugMode: the Rust
            // stderr reader needs the on-disk value at spawn time.
            await writeDesktopConfig({ llmDumpToFile: next });
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
                    checked={diskDebug}
                    disabled={saving}
                    onChange={(next) => void setDebug(next)}
                    label={t("settings.debugModeEnabled")}
                />
            </div>
            {diskDebug && (
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
                        checked={diskLlmDump}
                        disabled={saving}
                        onChange={(next) => void setLlmDump(next)}
                        label={t("settings.llmDumpToFileEnabled")}
                    />
                </div>
            )}
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
