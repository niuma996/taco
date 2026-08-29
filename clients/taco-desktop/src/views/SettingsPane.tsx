/**
 * SettingsPane — full-width settings view (shown when mainView = 'settings').
 *
 * Replaces the former right-side SettingsDrawer: same four sections
 * (appearance / model / compaction / debug), same tab components reused
 * unchanged, but laid out as a left vertical section nav + a centered,
 * width-capped content column instead of a 420px-wide drawer.
 *
 * MCP is not here — it lives on the activity rail as its own top-level view.
 * Schedules likewise moved to the activity rail (daemon-side scheduler UI).
 */
import type { WorkspaceId } from "@taco-ai/protocol";
import { useState } from "react";
import { AppearanceTab } from "../components/settings/AppearanceTab.tsx";
import { CompactionTab } from "../components/settings/CompactionTab.tsx";
import { ContextTab } from "../components/settings/ContextTab.tsx";
import { DebugTab } from "../components/settings/DebugTab.tsx";
import type { ModelOption } from "../components/settings/ModelPicker.tsx";
import { ModelTab } from "../components/settings/ModelTab.tsx";
import { PermissionsTab } from "../components/settings/PermissionsTab.tsx";
import { UpdatesTab } from "../components/settings/UpdatesTab.tsx";
import { useT } from "../i18n/useI18n.ts";
import type { TacoClient } from "../lib/clients/tacoClient.ts";

export type SettingsSection =
    | "appearance"
    | "model"
    | "compaction"
    | "context"
    | "permissions"
    | "debug"
    | "updates";

type SectionLabelKey =
    | "settings.tabAppearance"
    | "settings.tabModel"
    | "settings.tabCompaction"
    | "settings.tabContext"
    | "settings.tabPermissions"
    | "settings.tabDebug"
    | "settings.tabUpdates";

const SECTIONS: ReadonlyArray<{ key: SettingsSection; labelKey: SectionLabelKey }> = [
    { key: "appearance", labelKey: "settings.tabAppearance" },
    { key: "model", labelKey: "settings.tabModel" },
    { key: "compaction", labelKey: "settings.tabCompaction" },
    { key: "context", labelKey: "settings.tabContext" },
    { key: "permissions", labelKey: "settings.tabPermissions" },
    { key: "debug", labelKey: "settings.tabDebug" },
    { key: "updates", labelKey: "settings.tabUpdates" },
];

export interface SettingsPaneProps {
    client: TacoClient;
    /** Triggers sidecar disposeAll + re-ensure — used by DebugTab. */
    onRestartSidecar: () => Promise<void>;
    modelOptions: ModelOption[];
    /** Current workspace — the Model tab's providers section calls providers.list. */
    workspace: WorkspaceId | null;
    /** Called when the Model tab's picker opens its dropdown, triggering a model-list refresh. */
    onRefreshModels?: () => void;
    /** Last known available update from the mount-time check, or null. */
    updateAvailable: { version: string } | null;
    /** True while a check is in flight — disables the Check now button. */
    updateChecking: boolean;
    /** Last check error message (null = no error). */
    updateError: string | null;
    /** Triggers a fresh checkForUpdate() — App.tsx owns the result. */
    onCheckUpdate: () => void;
}

export function SettingsPane(props: SettingsPaneProps) {
    const { t } = useT();
    const [section, setSection] = useState<SettingsSection>("appearance");

    return (
        <div className="settings-pane">
            <nav className="settings-nav" aria-label={t("app.settings")}>
                {SECTIONS.map((s) => (
                    <button
                        key={s.key}
                        type="button"
                        className={`settings-nav-item${section === s.key ? " active" : ""}`}
                        onClick={() => setSection(s.key)}
                    >
                        {t(s.labelKey)}
                    </button>
                ))}
            </nav>
            <div className="settings-pane-content">
                <div className="settings-pane-content-inner">
                    {section === "appearance" && <AppearanceTab client={props.client} />}
                    {section === "model" && (
                        <ModelTab
                            options={props.modelOptions}
                            client={props.client}
                            workspace={props.workspace}
                            onRefreshModels={props.onRefreshModels}
                        />
                    )}
                    {section === "compaction" && <CompactionTab client={props.client} />}
                    {section === "context" && <ContextTab client={props.client} />}
                    {section === "permissions" && <PermissionsTab client={props.client} />}
                    {section === "debug" && <DebugTab onRestart={props.onRestartSidecar} />}
                    {section === "updates" && (
                        <UpdatesTab
                            updateAvailable={props.updateAvailable}
                            checking={props.updateChecking}
                            lastError={props.updateError}
                            onCheck={props.onCheckUpdate}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
