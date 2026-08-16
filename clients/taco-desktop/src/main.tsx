import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/ToastProvider";
import { bootstrapI18n, default as i18n } from "./i18n/index.ts";
import { getGlobalConfig, loadClientConfig } from "./lib/globalConfig.ts";
import { resolveTheme } from "./lib/theme";
import "./components/toolViews"; // side-effect: register tool views before App renders
import "./styles.css";

// Initialize i18next synchronously BEFORE render so the first paint uses the
// persisted UI language (no English flash on a Chinese user).
bootstrapI18n();

const rootEl = document.getElementById("root");
if (!rootEl) {
    throw new Error("root element not found");
}

// macOS traffic lights need top-bar padding; other platforms don't.
if (navigator.userAgent.includes("Macintosh")) {
    document.documentElement.dataset.platform = "macos";
}

// Populate the global config cache synchronously BEFORE React mounts so that
// the `useTheme` effect inside App can resolve the persisted theme on its
// very first apply() — without this, the effect would read an empty client
// cache, fall back to the OS scheme, and overwrite the theme that paint
// just rendered with (the source of the brief dark→light / light→dark
// flicker reported on first launch).
loadClientConfig();

// Anti-FOUC: now that the cache holds the persisted theme preference,
// resolve the concrete theme and write data-theme synchronously before
// React mounts. Order: localStorage (last user choice) → OS preference
// fallback. useTheme reconciles on the next emit (same value, no jump).
const osDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const initialTheme = resolveTheme(getGlobalConfig().client.theme, osDark);
document.documentElement.dataset.theme = initialTheme;

ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
        <I18nextProvider i18n={i18n}>
            <ErrorBoundary>
                <ToastProvider>
                    <App />
                </ToastProvider>
            </ErrorBoundary>
        </I18nextProvider>
    </React.StrictMode>,
);
