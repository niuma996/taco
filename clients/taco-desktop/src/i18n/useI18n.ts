/**
 * Thin wrappers around react-i18next's hooks.
 *
 * `useTranslation` is re-exported as `useT` (more searchable than `t` alone).
 * `useUiLanguage` returns the *active* language reactively — components that
 * depend on the language identity (e.g. conditionally rendering a flag) should
 * use this, not `i18n.language` directly.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SupportedUiLanguage } from "./index.ts";
import i18n from "./index.ts";

export function useT() {
    return useTranslation();
}

export function useUiLanguage(): SupportedUiLanguage {
    const [lng, setLng] = useState<SupportedUiLanguage>(
        (i18n.language as SupportedUiLanguage) ?? "en",
    );
    useEffect(() => {
        const handler = (next: string) => setLng(next as SupportedUiLanguage);
        i18n.on("languageChanged", handler);
        return () => {
            i18n.off("languageChanged", handler);
        };
    }, []);
    return lng;
}
