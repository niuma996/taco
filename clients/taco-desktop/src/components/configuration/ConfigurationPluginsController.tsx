import { useQueryClient } from "@tanstack/react-query";
import { usePluginsPane } from "../../hooks/usePluginsPane";
import type { TacoClient } from "../../lib/clients/tacoClient";
import { refreshQueries, resourceQueryKey } from "../../lib/queries/queryClient";
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
    const queryClient = useQueryClient();
    const plugins = usePluginsPane(client, active, activeCwd, restartSidecar);

    if (!active) return null;
    return (
        <PluginsPane
            settings={{
                client,
                onSaved: () =>
                    refreshQueries(queryClient, { queryKey: resourceQueryKey(client, "plugins") }),
            }}
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
