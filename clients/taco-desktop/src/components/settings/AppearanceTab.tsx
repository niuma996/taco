import type { ThemePreference } from "../../lib/clientSettings.ts";
/**
 * AppearanceTab — Settings drawer "Appearance" tab: light/dark/system theme and UI language.
 *
 * Subscribes to `globalConfig.ts`; changes are reactive via useTheme writing `data-theme`
 * for immediate effect. Language changes trigger `i18n.changeLanguage` via the subscriber
 * set up in `wireI18nToClientSettings()`.
 */

import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { SUPPORTED_UI_LANGUAGES, type SupportedUiLanguage } from "../../i18n/index.ts";
import { useT, useUiLanguage } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { Select } from "../ui/Select.tsx";

export interface AppearanceTabProps {
    client: TacoClient;
}

// Theme options — translated via i18n; renders as "Light / Dark / Follow system" in
// English and "Light / Dark / Follow system" in Chinese.
const OPTIONS: ReadonlyArray<{
    value: ThemePreference;
    labelKey:
        | "settings.themeOptionLight"
        | "settings.themeOptionDark"
        | "settings.themeOptionSystem";
}> = [
    { value: "light", labelKey: "settings.themeOptionLight" },
    { value: "dark", labelKey: "settings.themeOptionDark" },
    { value: "system", labelKey: "settings.themeOptionSystem" },
];

export function AppearanceTab(props: AppearanceTabProps) {
    const state = useGlobalConfig();
    const { save, saving, error } = useSaveConfigPatch(props.client);
    const { t } = useT();

    const current: ThemePreference = state.client.theme ?? "system";
    const uiLanguage = useUiLanguage();

    const saveLanguage = async (next: SupportedUiLanguage): Promise<void> => {
        await save({ kind: "client", patch: { uiLanguage: next } });
    };

    return (
        <section className="settings-tab">
            <h3>{t("settings.appearanceTitle")}</h3>
            <p className="settings-tab-desc">{t("settings.appearanceDesc")}</p>
            <div className="settings-row">
                <Select
                    value={current}
                    options={OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                    onValueChange={(v) =>
                        void save({ kind: "client", patch: { theme: v as ThemePreference } })
                    }
                    disabled={saving}
                    label={t("app.theme")}
                />
                {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
            </div>
            <section className="settings-tab-subsection">
                <h3>{t("settings.languageTitle")}</h3>
                <p className="settings-tab-desc">{t("settings.languageDesc")}</p>
                <div className="settings-row">
                    <Select
                        value={uiLanguage}
                        options={SUPPORTED_UI_LANGUAGES.map((lng) => ({
                            value: lng,
                            label:
                                lng === "zh"
                                    ? t("settings.languageOptionZh")
                                    : t("settings.languageOptionEn"),
                        }))}
                        onValueChange={(v) => void saveLanguage(v as SupportedUiLanguage)}
                        disabled={saving}
                        label={t("app.language")}
                    />
                    {saving && <span className="settings-saving">{t("drawer.savingInline")}</span>}
                </div>
            </section>
            {error && <div className="error-banner">{error}</div>}
        </section>
    );
}
