/**
 * CompactionTab — Settings drawer "Context / Compaction" tab.
 *
 * Enable/disable auto-compaction and tune its trigger threshold (0..1 slider).
 * Writes go through the existing `settings.write` RPC (nested shallow merge),
 * so patching just `{ compaction: { enabled } }` or `{ compaction: { threshold } }`
 * correctly preserves the other field. Visual style reuses AppearanceTab classes.
 */

import {
    COMPACTION_THRESHOLD_MAX,
    COMPACTION_THRESHOLD_MIN,
    DEFAULT_COMPACTION_ENABLED,
    DEFAULT_COMPACTION_THRESHOLD,
} from "@taco-ai/protocol";
import { useCallback, useRef, useState } from "react";
import { useGlobalConfig } from "../../hooks/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/useSaveConfigPatch.ts";
import { useT } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { Slider } from "../ui/Slider.tsx";
import { Switch } from "../ui/Switch.tsx";

export interface CompactionTabProps {
    client: TacoClient;
}

/**
 * Slider step — UI granularity, not a service contract. Bounds and default
 * come from `@taco-ai/protocol` so this client can never drift out of sync
 * with the sidecar's `settings.write` validator.
 */
const THRESHOLD_STEP = 0.05;

function clampThreshold(value: number): number {
    if (Number.isNaN(value)) return DEFAULT_COMPACTION_THRESHOLD;
    return Math.min(COMPACTION_THRESHOLD_MAX, Math.max(COMPACTION_THRESHOLD_MIN, value));
}

export function CompactionTab(props: CompactionTabProps) {
    const state = useGlobalConfig();
    const { save, saving, error } = useSaveConfigPatch(props.client);
    const { t } = useT();

    // `compaction` is optional in the view shape; missing values fall back to
    // sidecar defaults (DEFAULT_COMPACTION_ENABLED, DEFAULT_COMPACTION_THRESHOLD).
    const configured = state.global.compaction ?? {
        enabled: DEFAULT_COMPACTION_ENABLED,
        threshold: DEFAULT_COMPACTION_THRESHOLD,
    };
    const enabled = configured.enabled ?? DEFAULT_COMPACTION_ENABLED;
    const threshold = clampThreshold(
        typeof configured.threshold === "number"
            ? configured.threshold
            : DEFAULT_COMPACTION_THRESHOLD,
    );

    const savePatch = async (patch: { enabled?: boolean; threshold?: number }): Promise<void> => {
        await save({ kind: "global", patch: { compaction: patch } });
    };

    // While dragging the slider, only update the local visual value; commit
    // via RPC on pointer/key release to avoid writing on every onChange tick.
    const [draftThreshold, setDraftThreshold] = useState<number | null>(null);
    const displayThreshold = draftThreshold ?? threshold;
    const savePatchRef = useRef(savePatch);
    savePatchRef.current = savePatch;
    const commitThreshold = useCallback(() => {
        setDraftThreshold((prev) => {
            if (prev === null) return null;
            void savePatchRef.current({ threshold: prev });
            return null;
        });
    }, []);

    const thresholdPercent = Math.round(displayThreshold * 100);

    return (
        <section className="settings-tab">
            <h3>{t("settings.compactionTitle")}</h3>
            <p className="settings-tab-desc">{t("settings.compactionDesc")}</p>
            <div className="settings-row compaction-toggle-row">
                <div className="compaction-toggle-text">
                    <span className="compaction-toggle-label">
                        {t("settings.compactionEnabled")}
                    </span>
                    <span className="compaction-toggle-desc">
                        {t("settings.compactionEnabledDesc")}
                    </span>
                </div>
                <Switch
                    checked={enabled}
                    disabled={saving}
                    onChange={(next) => void savePatch({ enabled: next })}
                    label={t("settings.compactionEnabled")}
                />
            </div>
            <div
                className={`settings-row compaction-threshold${enabled ? "" : " off"}`}
                aria-disabled={!enabled || saving}
            >
                <div className="compaction-threshold-labels">
                    <span>
                        {t("settings.compactionThreshold", {
                            percent: `${thresholdPercent}%`,
                        })}
                    </span>
                    <Slider
                        value={displayThreshold}
                        min={COMPACTION_THRESHOLD_MIN}
                        max={COMPACTION_THRESHOLD_MAX}
                        step={THRESHOLD_STEP}
                        disabled={!enabled || saving}
                        ariaLabel={t("settings.compactionThreshold")}
                        ariaValueText={`${thresholdPercent}%`}
                        onValueChange={(v) => setDraftThreshold(v)}
                        onValueCommit={commitThreshold}
                    />
                </div>
            </div>
            <p className="settings-tab-desc">{t("settings.compactionThresholdHint")}</p>
            <p className="settings-tab-desc">{t("settings.compactionManualHint")}</p>
            {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}
