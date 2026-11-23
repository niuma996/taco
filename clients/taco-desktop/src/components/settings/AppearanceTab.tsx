import type { ThemePreference } from "../../lib/clientSettings.ts";
/**
 * AppearanceTab — Settings drawer "Appearance" tab: light/dark/system theme and UI language.
 *
 * Subscribes to `globalConfig.ts`; changes are reactive via useTheme writing `data-theme`
 * for immediate effect. Language changes trigger `i18n.changeLanguage` via the subscriber
 * set up in `wireI18nToClientSettings()`.
 */

import { Languages, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useGlobalConfig } from "../../hooks/primitives/useGlobalConfig.ts";
import { useSaveConfigPatch } from "../../hooks/primitives/useSaveConfigPatch.ts";
import { SUPPORTED_UI_LANGUAGES, type SupportedUiLanguage } from "../../i18n/index.ts";
import { useT, useUiLanguage } from "../../i18n/useI18n.ts";
import type { TacoClient } from "../../lib/clients/tacoClient.ts";
import { OptionCardGroup } from "../ui/OptionCardGroup.tsx";

export interface AppearanceTabProps {
    client: TacoClient;
}

const OPTIONS: ReadonlyArray<{
    value: ThemePreference;
    labelKey:
        | "settings.themeOptionLight"
        | "settings.themeOptionDark"
        | "settings.themeOptionSystem";
    icon: ReactNode;
}> = [
    { value: "light", labelKey: "settings.themeOptionLight", icon: <Sun size={18} /> },
    { value: "dark", labelKey: "settings.themeOptionDark", icon: <Moon size={18} /> },
    { value: "system", labelKey: "settings.themeOptionSystem", icon: <Monitor size={18} /> },
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
                <OptionCardGroup<ThemePreference>
                    value={current}
                    items={OPTIONS.map((option) => ({
                        value: option.value,
                        label: t(option.labelKey),
                        icon: option.icon,
                    }))}
                    onValueChange={(next) => void save({ kind: "client", patch: { theme: next } })}
                    disabled={saving}
                    label={t("app.theme")}
                />
            </div>
            <section className="settings-tab-subsection">
                <h3>{t("settings.languageTitle")}</h3>
                <p className="settings-tab-desc">{t("settings.languageDesc")}</p>
                <div className="settings-row">
                    <OptionCardGroup<SupportedUiLanguage>
                        value={uiLanguage}
                        items={SUPPORTED_UI_LANGUAGES.map((language) => ({
                            value: language,
                            label:
                                language === "zh"
                                    ? t("settings.languageOptionZh")
                                    : t("settings.languageOptionEn"),
                            icon: <Languages size={18} />,
                        }))}
                        onValueChange={(next) => void saveLanguage(next)}
                        disabled={saving}
                        label={t("app.language")}
                    />
                </div>
            </section>
            {saving && (
                <div className="settings-row">
                    <span className="settings-saving">{t("app.saving")}</span>
                </div>
            )}
            {error && (
                <div className="error-banner" role="alert">
                    {error}
                </div>
            )}
        </section>
    );
}
