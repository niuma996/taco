/**
 * Resolves local theme preference plus OS color scheme into `data-theme`.
 * System mode tracks matchMedia changes; explicit light/dark modes ignore them.
 * Parsing remains in lib/theme.ts; this hook only coordinates side effects.
 */
import { useEffect } from "react";

import { getGlobalConfig, subscribeGlobalConfig } from "../lib/globalConfig.ts";
import { resolveTheme } from "../lib/theme.ts";

const MEDIA = "(prefers-color-scheme: dark)";

export function useTheme(): void {
    useEffect(() => {
        const mq = window.matchMedia(MEDIA);
        // apply closes over `mq` so the snapshot read and the listener share the
        // same MediaQueryList object (avoids re-constructing per call).
        const apply = () => {
            // Local client settings bypass the sidecar and are loaded from localStorage.
            // An unset preference falls back to the OS scheme inside resolveTheme.
            const state = getGlobalConfig();
            const pref = state.client.theme;
            const resolved = resolveTheme(pref, mq.matches);
            document.documentElement.dataset.theme = resolved;
        };
        // Subscribe first; registration does not emit synchronously, so apply will not run twice.
        const unsubscribe = subscribeGlobalConfig(apply);
        mq.addEventListener("change", apply);
        return () => {
            unsubscribe();
            mq.removeEventListener("change", apply);
        };
    }, []);
}
