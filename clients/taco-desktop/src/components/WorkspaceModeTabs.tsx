/**
 * WorkspaceModeTabs — segmented switch in front of the workspace picker and
 * the chat navigation column. It filters the visible targets without opening
 * a workspace or conversation by itself.
 */

import type { KeyboardEvent } from "react";
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
        </div>
    );
}
