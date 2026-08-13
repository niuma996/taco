/**
 * Theme resolution — pure functions, no DOM dependency; safe for Node unit testing.
 *
 * DOM side effects (writing document.documentElement.dataset.theme, listening to matchMedia)
 * live in hooks/useTheme.ts; this module only maps preference + OS dark? → concrete theme.
 */
import type { ThemePreference } from "./clientSettings.ts";

/** Resolved concrete theme (actual value of data-theme). */
export type ResolvedTheme = "light" | "dark";

/**
 * Folds a user preference into a concrete theme.
 *
 * @param pref  setting theme; undefined or invalid values treated as "system".
 * @param osDark  current OS dark mode (from matchMedia), injected by the caller for testability.
 */
export function resolveTheme(pref: ThemePreference | undefined, osDark: boolean): ResolvedTheme {
    const effective: ThemePreference =
        pref === "light" || pref === "dark" || pref === "system" ? pref : "system";
    if (effective === "system") return osDark ? "dark" : "light";
    return effective;
}
