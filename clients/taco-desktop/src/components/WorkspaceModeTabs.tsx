/**
 * WorkspaceModeTabs — the workspace / channel-chat switch in the topbar.
 *
 * Plain-text segments on an equal-width grid plus a single accent underline
 * that slides between them. Every segment gets the same line length (one
 * column), so the line never changes size — it only travels — and a third
 * segment later needs no change to the switch itself.
 */

import type { CSSProperties, KeyboardEvent } from "react";
import { useT } from "../i18n/useI18n";

export type WorkspaceMode = "workspace" | "im";

export interface WorkspaceModeTabsProps {
    mode: WorkspaceMode;
    onModeChange: (mode: WorkspaceMode) => void;
}

export function WorkspaceModeTabs({ mode, onModeChange }: WorkspaceModeTabsProps) {
    const { t } = useT();
    const tabs: { value: WorkspaceMode; label: string }[] = [
        { value: "workspace", label: t("workspaceMode.workspace") },
        { value: "im", label: t("workspaceMode.im") },
    ];
    const activeIndex = Math.max(
        0,
        tabs.findIndex((tab) => tab.value === mode),
    );

    // Arrow keys move between the two segments, as a radio group does.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onModeChange(mode === "workspace" ? "im" : "workspace");
    };

    return (
        <div
            className="workspace-mode-tabs"
            role="radiogroup"
            aria-label={t("workspaceMode.label")}
            onKeyDown={onKeyDown}
            // The underline's length and travel are pure CSS: one column wide,
            // moved by the active index.
            style={
                {
                    "--tab-count": tabs.length,
                    "--tab-index": activeIndex,
                } as CSSProperties
            }
        >
            {tabs.map(({ value, label }) => {
                const active = value === mode;
                return (
                    // biome-ignore lint/a11y/useSemanticElements: a two-segment switch styled as a pill; native radio inputs cannot carry the segment styling
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={label}
                        title={label}
                        tabIndex={active ? 0 : -1}
                        className={`workspace-mode-tab${active ? " workspace-mode-tab--active" : ""}`}
                        onClick={() => onModeChange(value)}
                    >
                        {label}
                    </button>
                );
            })}
            <span className="workspace-mode-tabs__underline" aria-hidden="true" />
        </div>
    );
}
