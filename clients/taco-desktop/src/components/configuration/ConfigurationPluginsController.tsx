import { usePluginsPane } from "../../hooks/usePluginsPane";
import type { TacoClient } from "../../lib/clients/tacoClient";
import { PluginsPane } from "../../views/PluginsPane";

export interface ConfigurationPluginsControllerProps {
    active: boolean;
    client: TacoClient;
    activeCwd: string | undefined;
    restartSidecar: () => Promise<void>;
}

export function ConfigurationPluginsController({
    active,
    client,
    activeCwd,
    restartSidecar,
}: ConfigurationPluginsControllerProps) {
    const plugins = usePluginsPane(client, active, activeCwd, restartSidecar);

    if (!active) return null;
    return (
        <PluginsPane
            status={plugins.extensionStatus}
            loading={plugins.extensionLoading}
            error={plugins.extensionError}
            savingName={plugins.extensionSavingName}
            onToggle={(name, nextDisabled) => void plugins.toggleExtension(name, nextDisabled)}
            pendingRestart={plugins.extensionPendingRestart}
            restarting={plugins.extensionRestarting}
            onRestart={() => void plugins.restartForPlugins()}
        />
    );
}
