/**
 * Pure-client settings: localStorage persistence.
 *
 * Settings unrelated to the sidecar protocol (theme, debugMode, etc.) live
 * here — they aren't written to ~/.taco/taco.json or sent via sidecar RPC.
 *
 * Calling patterns:
 *  - First-paint FOUC guard (main.tsx synchronous path):
 *    `readPersistedThemePreference()`
 *  - Subscription model (globalConfig.ts):
 *    `readClientSettings()` + `saveClientSettings()`
 *
 * Currently holds theme + debugMode + llmDumpToFile + uiLanguage; future
 * pure-UI prefs (font size, etc.) also go here.
 */

/** Theme preference: light / dark / follow-system. Default (`undefined`) is treated as `system`. */
export type ThemePreference = "light" | "dark" | "system";

/** UI language preference: Chinese / English. Default (`undefined`) is resolved from the browser / system locale. */
export type UiLanguagePreference = "zh" | "en";

/**
 * Field shape for pure-client settings — stored client-side (localStorage /
 * Tauri app config), never crosses the sidecar protocol boundary, never
 * written to ~/.taco/taco.json.
 *
 * Design principle: these fields are independent of the sidecar; the sidecar
 * neither knows nor cares about them at startup or at runtime.
 *  - theme: light / dark / follow-system. Pure UI rendering.
 *  - debugMode: the Tauri host reads this when spawning the sidecar to
 *    decide whether to inject TACO_DEBUG_LLM_PAYLOAD=1; the sidecar only
 *    sees an env gate and is unaware of this field.
 *  - llmDumpToFile: second opt-in that lets the user also tee the
 *    `[taco:llm]` lines into `$TACO_HOME/logs/llm-dump.log` on disk.
 *    Separate from `debugMode` because the in-memory panel is benign
 *    while the disk write puts plaintext conversation in the user's
 *    home dir; the Debug tab hides this row unless `debugMode` is on.
 *    Mirrored to `~/.taco/desktop.json` so the Rust host can read it
 *    without crossing the WebView boundary.
 *
 * Future pure-UI preferences also live here.
 */
export interface TacoClientSettingsShape {
    theme?: ThemePreference;
    /**
     * When on, the Tauri host injects TACO_DEBUG_LLM_PAYLOAD=1 when spawning
     * the sidecar; the sidecar then writes every LLM call's full request to
     * stderr (prefixed `[taco:llm]`), which the desktop LLM Dump panel
     * consumes. Changes only take effect after a sidecar restart.
     */
    debugMode?: boolean;
    /**
     * Second opt-in: also append every `[taco:llm]` line to
     * `$TACO_HOME/logs/llm-dump.log` (owner-only, 10 MiB rotation × 3
     * retained). The Rust stderr reader applies this filter — the sidecar
     * is unaware of the toggle and keeps writing to stderr. Only takes
     * effect when `debugMode` is on (the stderr source) and after restart.
     */
    llmDumpToFile?: boolean;
    /**
     * Desktop UI language. Drives react-i18next + the per-turn `<reply_language>`
     * tag sent to the LLM. Pure client field — never crosses the sidecar boundary.
     * Defaults to undefined (= system / browser locale resolved at first paint).
     */
    uiLanguage?: UiLanguagePreference;
}

export const LS_THEME = "taco.theme";
export const LS_DEBUG_MODE = "taco.debugMode";
export const LS_LLM_DUMP_TO_FILE = "taco.llmDumpToFile";
export const LS_UI_LANGUAGE = "taco.uiLanguage";
export const LS_SIDEBAR_COLLAPSED = "taco.sidebarCollapsed";

function isValidTheme(v: unknown): v is ThemePreference {
    return v === "light" || v === "dark" || v === "system";
}

export function isValidUiLanguage(v: unknown): v is UiLanguagePreference {
    return v === "zh" || v === "en";
}

function isBoolean(v: unknown): v is boolean {
    return typeof v === "boolean";
}

/**
 * Synchronously read `key` from localStorage, JSON-parsing the value and
 * validating it through `guard`. Returns `undefined` on any failure path
 * (key absent, parse error, validator rejection, storage unavailable).
 */
function readLs<T>(key: string, guard: (v: unknown) => v is T): T | undefined {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return guard(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Write `value` to localStorage under `key` as JSON. Passing `undefined`
 * removes the key (returning the slot to default resolution). Swallows
 * storage errors so they never break the UI (private mode / quota).
 */
function writeLs<T>(key: string, value: T | undefined): void {
    try {
        if (value === undefined) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, JSON.stringify(value));
        }
    } catch {
        // Quietly swallow when localStorage is unavailable (private mode / quota)
        // so the UI never breaks.
    }
}

export interface PersistedClientSettings {
    theme?: ThemePreference;
    debugMode?: boolean;
    llmDumpToFile?: boolean;
    uiLanguage?: UiLanguagePreference;
}

/** Synchronously read the theme preference from localStorage; returns undefined for missing / invalid values. */
export function readPersistedThemePreference(): ThemePreference | undefined {
    return readLs(LS_THEME, isValidTheme);
}

function writePersistedThemePreference(pref: ThemePreference | undefined): void {
    writeLs(LS_THEME, pref);
}

/** Synchronously read the debugMode preference; returns undefined when localStorage is unavailable or the value is missing. */
function readPersistedDebugMode(): boolean | undefined {
    return readLs(LS_DEBUG_MODE, isBoolean);
}

function writePersistedDebugMode(v: boolean | undefined): void {
    writeLs(LS_DEBUG_MODE, v);
}

/** Synchronously read the llmDumpToFile preference; same fallback contract as readPersistedDebugMode. */
function readPersistedLlmDumpToFile(): boolean | undefined {
    return readLs(LS_LLM_DUMP_TO_FILE, isBoolean);
}

function writePersistedLlmDumpToFile(v: boolean | undefined): void {
    writeLs(LS_LLM_DUMP_TO_FILE, v);
}

/** Synchronously read the uiLanguage preference; returns undefined for missing / invalid values. */
export function readPersistedUiLanguage(): UiLanguagePreference | undefined {
    return readLs(LS_UI_LANGUAGE, isValidUiLanguage);
}

export function writePersistedUiLanguage(pref: UiLanguagePreference | undefined): void {
    writeLs(LS_UI_LANGUAGE, pref);
}

/** Synchronously read the chat sidebar collapsed state; returns undefined when missing / invalid. */
export function readPersistedSidebarCollapsed(): boolean | undefined {
    return readLs(LS_SIDEBAR_COLLAPSED, isBoolean);
}

export function writePersistedSidebarCollapsed(v: boolean | undefined): void {
    writeLs(LS_SIDEBAR_COLLAPSED, v);
}

function readRaw(): PersistedClientSettings {
    const theme = readPersistedThemePreference();
    const debugMode = readPersistedDebugMode();
    const llmDumpToFile = readPersistedLlmDumpToFile();
    const uiLanguage = readPersistedUiLanguage();
    const out: PersistedClientSettings = {};
    if (theme !== undefined) out.theme = theme;
    if (debugMode !== undefined) out.debugMode = debugMode;
    if (llmDumpToFile !== undefined) out.llmDumpToFile = llmDumpToFile;
    if (uiLanguage !== undefined) out.uiLanguage = uiLanguage;
    return out;
}

function writeRaw(next: PersistedClientSettings): void {
    writePersistedThemePreference(next.theme);
    writePersistedDebugMode(next.debugMode);
    writePersistedLlmDumpToFile(next.llmDumpToFile);
    writePersistedUiLanguage(next.uiLanguage);
}

/** Read the entire client settings; for the subscription model (returns the full view). */
export function readClientSettings(): PersistedClientSettings {
    return readRaw();
}

/** Patch + write, returning the latest view. Throws on unknown / invalid theme. */
export function saveClientSettings(
    patch: Partial<PersistedClientSettings>,
): PersistedClientSettings {
    const current = readRaw();
    const next: PersistedClientSettings = { ...current };
    if ("theme" in patch) {
        const t = patch.theme;
        if (t === undefined || t === null) {
            // undefined / null → drop the key (back to `system` default).
            next.theme = undefined;
        } else if (isValidTheme(t)) {
            next.theme = t;
        } else {
            throw new Error(`saveClientSettings: invalid theme value ${JSON.stringify(t)}`);
        }
    }
    if ("debugMode" in patch) {
        // debugMode is a boolean; undefined here is "keep the current value"
        // (same semantics as theme).
        if (patch.debugMode === undefined) {
            next.debugMode = undefined;
        } else {
            next.debugMode = patch.debugMode;
        }
    }
    if ("llmDumpToFile" in patch) {
        // Same boolean contract as debugMode. Requires debugMode on for the
        // source lines to exist; the Debug tab hides this row when off.
        if (patch.llmDumpToFile === undefined) {
            next.llmDumpToFile = undefined;
        } else {
            next.llmDumpToFile = patch.llmDumpToFile;
        }
    }
    if ("uiLanguage" in patch) {
        const u = patch.uiLanguage;
        if (u === undefined || u === null) {
            next.uiLanguage = undefined;
        } else if (isValidUiLanguage(u)) {
            next.uiLanguage = u;
        } else {
            throw new Error(`saveClientSettings: invalid uiLanguage value ${JSON.stringify(u)}`);
        }
    }
    writeRaw(next);
    return next;
}
