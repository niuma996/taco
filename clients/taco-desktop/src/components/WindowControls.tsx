/**
 * WindowControls — custom min/maximize/close buttons for the frameless window.
 *
 * The window runs with `decorations: false` (tauri.conf.json), so the OS draws
 * no title bar or controls on any platform. This component supplies them,
 * driving the native window via the Tauri window API.
 *
 * Platform layout mirrors OS convention:
 *  - macOS  → traffic-light dots, pinned top-left (rendered by the caller on
 *             the left side of the topbar).
 *  - others → Windows-style square buttons, pinned top-right.
 * `document.documentElement.dataset.platform` is set once in main.tsx.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useT } from "../i18n/useI18n";

const isMac = (): boolean => document.documentElement.dataset.platform === "macos";

export function WindowControls() {
    const { t } = useT();
    const [maximized, setMaximized] = useState(false);
    // macOS traffic lights dim when the window loses focus; other platforms
    // don't read this but tracking it is harmless.
    const [focused, setFocused] = useState(true);

    // Track maximized (middle button icon) and focused (macOS dot color).
    // `disposed` guards the async listener registrations so a mid-flight
    // resolve after unmount can't leak a listener or set state.
    useEffect(() => {
        const win = getCurrentWindow();
        let disposed = false;
        const unlistens: Array<() => void> = [];

        void win
            .isMaximized()
            .then((v) => {
                if (!disposed) setMaximized(v);
            })
            .catch(() => {});
        void win
            .isFocused()
            .then((v) => {
                if (!disposed) setFocused(v);
            })
            .catch(() => {});

        void win
            .onResized(() => {
                void win
                    .isMaximized()
                    .then((v) => {
                        if (!disposed) setMaximized(v);
                    })
                    .catch(() => {});
            })
            .then((fn) => {
                if (disposed) fn();
                else unlistens.push(fn);
            })
            .catch(() => {});

        void win
            .onFocusChanged(({ payload }) => {
                if (!disposed) setFocused(payload);
            })
            .then((fn) => {
                if (disposed) fn();
                else unlistens.push(fn);
            })
            .catch(() => {});

        return () => {
            disposed = true;
            for (const fn of unlistens) fn();
        };
    }, []);

    const win = getCurrentWindow();
    const onMinimize = () => void win.minimize().catch(() => {});
    const onToggleMaximize = () => void win.toggleMaximize().catch(() => {});
    const onClose = () => void win.close().catch(() => {});

    if (isMac()) {
        // macOS: three traffic-light dots on the left. Color comes from CSS;
        // the cluster turns gray when the window is inactive (native behavior).
        const inactiveClass = focused ? "" : " window-controls--inactive";
        return (
            <div
                className={`window-controls window-controls--mac${inactiveClass}`}
                aria-label={t("window.controls")}
            >
                <button
                    type="button"
                    className="window-control-dot window-control-dot--close"
                    onClick={onClose}
                    aria-label={t("window.hide")}
                    title={t("window.hide")}
                />
                <button
                    type="button"
                    className="window-control-dot window-control-dot--minimize"
                    onClick={onMinimize}
                    aria-label={t("window.minimize")}
                    title={t("window.minimize")}
                />
                <button
                    type="button"
                    className="window-control-dot window-control-dot--maximize"
                    onClick={onToggleMaximize}
                    aria-label={t("window.maximize")}
                    title={t("window.maximize")}
                />
            </div>
        );
    }

    // Windows / Linux: square buttons on the right; close gets a red hover.
    return (
        <div className="window-controls window-controls--win" aria-label={t("window.controls")}>
            <button
                type="button"
                className="window-control-btn"
                onClick={onMinimize}
                aria-label={t("window.minimize")}
                title={t("window.minimize")}
            >
                <Minus size={16} aria-hidden="true" />
            </button>
            <button
                type="button"
                className="window-control-btn"
                onClick={onToggleMaximize}
                aria-label={maximized ? t("window.restore") : t("window.maximize")}
                title={maximized ? t("window.restore") : t("window.maximize")}
            >
                <Square size={13} aria-hidden="true" />
            </button>
            <button
                type="button"
                className="window-control-btn window-control-btn--close"
                onClick={onClose}
                aria-label={t("window.hide")}
                title={t("window.hide")}
            >
                <X size={16} aria-hidden="true" />
            </button>
        </div>
    );
}
