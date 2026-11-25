/**
 * WorkspaceModeTabs — the workspace / channel-chat switch in the topbar.
 *
 * Two equal-width segments. The selected one is a rounded, slightly raised
 * surface with a colour dot in front of its label — brand orange for the
 * workspace, accent blue for the channel chat. No underline and no track:
 * the pill is the whole chrome.
 *
 * Every segment carries the dot slot, visible or not, so both segments keep
 * the same length and the control never resizes when the selection moves.
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
                        className={`workspace-mode-tab workspace-mode-tab--${value}${active ? " workspace-mode-tab--active" : ""}`}
                        onClick={() => onModeChange(value)}
                    >
                        {/* The dot slot is in the layout even when the segment
                            is not selected — an empty placeholder of the same
                            size — so the two segments keep one length. */}
                        <span className="workspace-mode-tab__dot" aria-hidden="true" />
                        <span className="workspace-mode-tab__label">{label}</span>
                    </button>
                );
            })}
        </div>
    );
}
