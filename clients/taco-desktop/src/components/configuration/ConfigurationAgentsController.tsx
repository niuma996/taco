import { IM_CWD_PREFIX } from "@taco-ai/protocol";
import { useAgentsPane } from "../../hooks/useAgentsPane";
import { useConfigurationScope } from "../../hooks/useConfigurationScope";
import { AgentsPane } from "../../views/AgentsPane";
import {
    type ConfigurationControllerProps,
    ConfigurationPageLayout,
} from "./ConfigurationPageLayout";

export function ConfigurationAgentsController(props: ConfigurationControllerProps) {
    const { active, client } = props;
    const configuration = useConfigurationScope(props);
    const agents = useAgentsPane(client, active, configuration.targetCwd, configuration.scope);

    if (!active) return null;
    return (
        <ConfigurationPageLayout {...props} variant="catalog" configuration={configuration}>
            <AgentsPane
                key={`${configuration.targetCwd}:${configuration.scope}`}
                agents={agents.agents}
                globalAgentTypes={agents.globalAgentTypes}
                editorScope={
                    !configuration.hasTarget
                        ? undefined
                        : configuration.scope === "global"
                          ? "global"
                          : configuration.scope === "workspace" &&
                              !configuration.targetCwd?.startsWith(IM_CWD_PREFIX)
                            ? "workspace"
                            : undefined
                }
                error={agents.agentsError}
                selectedAgentType={agents.selectedAgentType ?? agents.agents[0]?.agentType ?? null}
                onSelect={agents.setSelectedAgentType}
                content={agents.agentContent}
                contentLoading={agents.agentContentLoading}
                contentError={agents.agentContentError}
                saving={agents.agentSaving}
                hasProjectDir={
                    configuration.targetCwd !== undefined &&
                    !configuration.targetCwd.startsWith(IM_CWD_PREFIX)
                }
                cwdChoices={agents.cwdChoices}
                codexRuntimeStatus={agents.codexRuntimeStatus}
                codexStatusLoading={agents.codexStatusLoading}
                codexInstalling={agents.codexInstalling}
                codexInstallError={agents.codexInstallError}
                onRefreshCodexRuntime={() => void agents.refreshCodexRuntime()}
                onInstallCodex={() => void agents.installCodexRuntime()}
                onSaveAgent={agents.saveAgent}
                onDeleteAgent={agents.deleteAgent}
            />
        </ConfigurationPageLayout>
    );
}
