import i18n from "../../i18n/index.ts";
import { useT, useUiLanguage } from "../../i18n/useI18n.js";
import { saveClientSettings } from "../../lib/clientSettings.js";
import { Select } from "../ui/Select.tsx";

export interface WelcomeStepProps {
    onStart: () => void;
}

export function WelcomeStep(props: WelcomeStepProps) {
    const { t } = useT();
    const uiLanguage = useUiLanguage();

    const handleLanguageChange = (lng: string) => {
        void i18n.changeLanguage(lng);
        saveClientSettings({ uiLanguage: lng as "en" | "zh" });
    };

    return (
        <div className="onboarding-step">
            <h2>{t("onboarding.welcomeTitle")}</h2>
            <p>{t("onboarding.welcomeBody")}</p>
            <div className="onboarding-welcome-language">
                <span className="onboarding-welcome-language-label">
                    {t("onboarding.languageTitle")}
                </span>
                <div className="onboarding-language-picker">
                    <Select
                        value={uiLanguage}
                        options={[
                            { value: "en", label: t("settings.languageOptionEn") },
                            { value: "zh", label: t("settings.languageOptionZh") },
                        ]}
                        onValueChange={handleLanguageChange}
                        label={t("app.language")}
                    />
                </div>
            </div>
            <button type="button" className="onboarding-cta" onClick={props.onStart}>
                {t("onboarding.startSetup")}
            </button>
        </div>
    );
}
