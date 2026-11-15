import { asWorkspaceId } from "@taco-ai/protocol";
import { SettingsPane, type SettingsPaneProps } from "../../views/SettingsPane";

export interface ConfigurationSettingsControllerProps
    extends Omit<SettingsPaneProps, "workspace" | "onRestartSidecar"> {
    active: boolean;
    activeCwd: string | undefined;
    restartSidecar: () => Promise<void>;
}

export function ConfigurationSettingsController({
    active,
    activeCwd,
    restartSidecar,
    ...props
}: ConfigurationSettingsControllerProps) {
    if (!active) return null;
    return (
        <SettingsPane
            {...props}
            workspace={activeCwd ? asWorkspaceId(activeCwd) : null}
            onRestartSidecar={restartSidecar}
        />
    );
}
