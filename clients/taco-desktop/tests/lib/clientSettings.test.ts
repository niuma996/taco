/**
 * clientSettings tests — mock the `localStorage` global since Node has none.
 *
 * Run:
 *   pnpm --filter @taco-ai/desktop test:storage
 *
 * We install a Map-backed stub on `globalThis.localStorage` before importing
 * the module under test; node:test runs each test file in a fresh worker, so
 * a `beforeEach` reset is enough.
 */

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
    isValidUiLanguage,
    LS_DEBUG_MODE,
    LS_LLM_DUMP_TO_FILE,
    LS_THEME,
    LS_UI_LANGUAGE,
    readClientSettings,
    readPersistedThemePreference,
    readPersistedUiLanguage,
    saveClientSettings,
    writePersistedUiLanguage,
} from "../../src/lib/clientSettings";

class MemoryStorage {
    private readonly map = new Map<string, string>();

    getItem(key: string): string | null {
        return this.map.has(key) ? (this.map.get(key) as string) : null;
    }

    setItem(key: string, value: string): void {
        this.map.set(key, String(value));
    }

    removeItem(key: string): void {
        this.map.delete(key);
    }

    clear(): void {
        this.map.clear();
    }
}

function installBrokenStorage(behaviour: "throwOnGet" | "throwOnSet"): void {
    const broken = {
        getItem: () => {
            throw new Error("localStorage unavailable");
        },
        setItem: () => {
            if (behaviour === "throwOnSet") throw new Error("quota exceeded");
        },
        removeItem: () => {},
        clear: () => {},
    };
    Object.defineProperty(globalThis, "localStorage", {
        value: broken,
        configurable: true,
        writable: true,
    });
}

let originalStorage: unknown;

beforeEach(() => {
    originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
        value: new MemoryStorage(),
        configurable: true,
        writable: true,
    });
});

afterEach(() => {
    if (originalStorage === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
    } else {
        Object.defineProperty(globalThis, "localStorage", {
            value: originalStorage,
            configurable: true,
            writable: true,
        });
    }
});

describe("clientSettings", () => {
    describe("readPersistedThemePreference", () => {
        it("returns undefined when key is absent", () => {
            assert.equal(readPersistedThemePreference(), undefined);
        });

        it("returns undefined on malformed JSON", () => {
            localStorage.setItem(LS_THEME, "{not json");
            assert.equal(readPersistedThemePreference(), undefined);
        });

        it("returns undefined on illegal value (e.g. someone hand-edited the key)", () => {
            localStorage.setItem(LS_THEME, JSON.stringify("neon"));
            assert.equal(readPersistedThemePreference(), undefined);
        });

        it("returns undefined when value is JSON `null`", () => {
            localStorage.setItem(LS_THEME, JSON.stringify(null));
            assert.equal(readPersistedThemePreference(), undefined);
        });

        it("returns undefined when localStorage.getItem throws", () => {
            installBrokenStorage("throwOnGet");
            assert.equal(readPersistedThemePreference(), undefined);
        });

        it("returns each valid ThemePreference", () => {
            for (const v of ["light", "dark", "system"] as const) {
                localStorage.setItem(LS_THEME, JSON.stringify(v));
                assert.equal(readPersistedThemePreference(), v);
            }
        });
    });

    describe("saveClientSettings (theme)", () => {
        it("stores each ThemePreference as JSON", () => {
            for (const v of ["light", "dark", "system"] as const) {
                saveClientSettings({ theme: v });
                assert.equal(localStorage.getItem(LS_THEME), JSON.stringify(v));
            }
        });

        it("removes the key when theme is undefined (back to system default)", () => {
            saveClientSettings({ theme: "light" });
            assert.ok(localStorage.getItem(LS_THEME));
            saveClientSettings({ theme: undefined });
            assert.equal(localStorage.getItem(LS_THEME), null);
        });

        it("silently swallows localStorage.setItem failures (privacy mode / quota)", () => {
            installBrokenStorage("throwOnSet");
            // Must not throw; UI theme still works, only cold-start loses the cache.
            assert.doesNotThrow(() => saveClientSettings({ theme: "light" }));
        });

        it("rejects illegal theme values", () => {
            assert.throws(
                () => saveClientSettings({ theme: "neon" as never }),
                /invalid theme value/,
            );
        });
    });

    describe("round-trip with write→read", () => {
        it("written value survives a subsequent read", () => {
            saveClientSettings({ theme: "dark" });
            assert.equal(readPersistedThemePreference(), "dark");
            saveClientSettings({ theme: undefined });
            assert.equal(readPersistedThemePreference(), undefined);
        });

        it("readClientSettings mirrors readPersistedThemePreference", () => {
            assert.deepEqual(readClientSettings(), {});
            saveClientSettings({ theme: "light" });
            assert.deepEqual(readClientSettings(), { theme: "light" });
        });
    });

    describe("debugMode", () => {
        it("absent by default", () => {
            assert.equal(readClientSettings().debugMode, undefined);
        });

        it("persists true / false independently", () => {
            saveClientSettings({ debugMode: true });
            assert.equal(readClientSettings().debugMode, true);
            assert.equal(localStorage.getItem(LS_DEBUG_MODE), "true");
            saveClientSettings({ debugMode: false });
            assert.equal(readClientSettings().debugMode, false);
            assert.equal(localStorage.getItem(LS_DEBUG_MODE), "false");
        });

        it("undefined clears the key", () => {
            saveClientSettings({ debugMode: true });
            assert.ok(localStorage.getItem(LS_DEBUG_MODE));
            saveClientSettings({ debugMode: undefined });
            assert.equal(localStorage.getItem(LS_DEBUG_MODE), null);
            assert.equal(readClientSettings().debugMode, undefined);
        });

        it("ignores malformed values in storage", () => {
            localStorage.setItem(LS_DEBUG_MODE, JSON.stringify("nope"));
            assert.equal(readClientSettings().debugMode, undefined);
        });

        it("theme and debugMode are independent fields", () => {
            saveClientSettings({ theme: "dark", debugMode: true });
            assert.deepEqual(readClientSettings(), { theme: "dark", debugMode: true });
            saveClientSettings({ theme: undefined });
            assert.deepEqual(readClientSettings(), { debugMode: true });
        });
    });

    describe("llmDumpToFile", () => {
        it("absent by default", () => {
            assert.equal(readClientSettings().llmDumpToFile, undefined);
        });

        it("persists true / false independently", () => {
            saveClientSettings({ llmDumpToFile: true });
            assert.equal(readClientSettings().llmDumpToFile, true);
            assert.equal(localStorage.getItem(LS_LLM_DUMP_TO_FILE), "true");
            saveClientSettings({ llmDumpToFile: false });
            assert.equal(readClientSettings().llmDumpToFile, false);
            assert.equal(localStorage.getItem(LS_LLM_DUMP_TO_FILE), "false");
        });

        it("undefined clears the key", () => {
            saveClientSettings({ llmDumpToFile: true });
            assert.ok(localStorage.getItem(LS_LLM_DUMP_TO_FILE));
            saveClientSettings({ llmDumpToFile: undefined });
            assert.equal(localStorage.getItem(LS_LLM_DUMP_TO_FILE), null);
            assert.equal(readClientSettings().llmDumpToFile, undefined);
        });

        it("ignores malformed values in storage", () => {
            localStorage.setItem(LS_LLM_DUMP_TO_FILE, JSON.stringify("nope"));
            assert.equal(readClientSettings().llmDumpToFile, undefined);
        });

        it("debugMode and llmDumpToFile are independent fields", () => {
            saveClientSettings({ debugMode: true, llmDumpToFile: true });
            assert.deepEqual(readClientSettings(), { debugMode: true, llmDumpToFile: true });
            saveClientSettings({ debugMode: undefined });
            assert.deepEqual(readClientSettings(), { llmDumpToFile: true });
        });
    });

    describe("uiLanguage", () => {
        it("readPersistedUiLanguage returns undefined when not set", () => {
            assert.equal(readPersistedUiLanguage(), undefined);
        });

        it("writes and reads 'zh'", () => {
            writePersistedUiLanguage("zh");
            assert.equal(readPersistedUiLanguage(), "zh");
            assert.equal(localStorage.getItem(LS_UI_LANGUAGE), JSON.stringify("zh"));
        });

        it("writes and reads 'en'", () => {
            writePersistedUiLanguage("en");
            assert.equal(readPersistedUiLanguage(), "en");
        });

        it("rejects invalid values on read", () => {
            localStorage.setItem(LS_UI_LANGUAGE, JSON.stringify("fr"));
            assert.equal(readPersistedUiLanguage(), undefined);
        });

        it("writePersistedUiLanguage(undefined) clears the key", () => {
            writePersistedUiLanguage("zh");
            writePersistedUiLanguage(undefined);
            assert.equal(readPersistedUiLanguage(), undefined);
            assert.equal(localStorage.getItem(LS_UI_LANGUAGE), null);
        });

        it("isValidUiLanguage type guard", () => {
            assert.equal(isValidUiLanguage("zh"), true);
            assert.equal(isValidUiLanguage("en"), true);
            assert.equal(isValidUiLanguage("fr"), false);
            assert.equal(isValidUiLanguage(null), false);
            assert.equal(isValidUiLanguage(42), false);
        });

        it("survives a saveClientSettings round trip", () => {
            writePersistedUiLanguage("zh");
            const all = readClientSettings();
            assert.equal(all.uiLanguage, "zh");
        });
    });

    describe("saveClientSettings (uiLanguage)", () => {
        it("stores each UiLanguagePreference as JSON", () => {
            for (const v of ["zh", "en"] as const) {
                saveClientSettings({ uiLanguage: v });
                assert.equal(localStorage.getItem(LS_UI_LANGUAGE), JSON.stringify(v));
            }
        });

        it("removes the key when uiLanguage is undefined", () => {
            saveClientSettings({ uiLanguage: "zh" });
            assert.ok(localStorage.getItem(LS_UI_LANGUAGE));
            saveClientSettings({ uiLanguage: undefined });
            assert.equal(localStorage.getItem(LS_UI_LANGUAGE), null);
        });

        it("rejects illegal uiLanguage values", () => {
            assert.throws(
                () => saveClientSettings({ uiLanguage: "fr" as never }),
                /invalid uiLanguage value/,
            );
        });
    });
});
