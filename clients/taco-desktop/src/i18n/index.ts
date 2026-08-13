/**
 * Desktop i18n setup — react-i18next backed by JSON locales.
 *
 * Bootstrap: main.tsx calls `bootstrapI18n()` before render, reading the persisted
 * uiLanguage synchronously from localStorage so the first paint uses the correct language.
 * `<I18nextProvider>` wraps the app; `<LanguageSync />` calls `i18n.changeLanguage` on settings changes.
 *
 * Locales are imported eagerly as ES modules and inlined by Vite — no code-splitting needed.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { readPersistedUiLanguage } from "../lib/clientSettings.ts";
import { subscribeGlobalConfig } from "../lib/globalConfig.ts";

import en from "./locales/en.json";
import zh from "./locales/zh.json";

export const SUPPORTED_UI_LANGUAGES = ["en", "zh"] as const;
export type SupportedUiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

/** Resolve the initial language synchronously from localStorage. */
function resolveInitialLanguage(): SupportedUiLanguage {
    const persisted = readPersistedUiLanguage();
    if (persisted) return persisted;
    // Fallback to browser language, narrowed to supported set.
    if (typeof navigator !== "undefined") {
        const nav = navigator.language.toLowerCase();
        if (nav.startsWith("zh")) return "zh";
    }
    return "en";
}

let bootstrapped = false;

/**
 * Subscribe to client settings changes and call `i18n.changeLanguage` when
 * `state.client.uiLanguage` changes. Returns the unsubscribe function.
 *
 * The `next !== i18n.language` guard prevents a no-op `changeLanguage` on the
 * first post-init write (which would still re-emit `languageChanged` and refresh every component).
 */
export function wireI18nToClientSettings(): () => void {
    return subscribeGlobalConfig((state) => {
        const next = state.client.uiLanguage;
        if (next && next !== i18n.language) {
            void i18n.changeLanguage(next);
        }
    });
}

/**
 * Initialize i18next exactly once. Safe to call multiple times — subsequent
 * calls are no-ops. main.tsx calls this synchronously before render.
 */
export function bootstrapI18n(): void {
    if (bootstrapped) return;
    bootstrapped = true;

    void i18n
        .use(initReactI18next)
        .init({
            resources: {
                en: { translation: en },
                zh: { translation: zh },
            },
            lng: resolveInitialLanguage(),
            fallbackLng: "en",
            interpolation: {
                // React already escapes — keep this off to avoid double-escape.
                escapeValue: false,
            },
            // Suspense false because we eagerly bundle all locales.
            react: { useSuspense: false },
        })
        .then(() => {
            // After init resolves, mirror persisted uiLanguage changes to the
            // live i18n instance so the language picker updates the UI in place.
            wireI18nToClientSettings();
        });
}

export default i18n;
