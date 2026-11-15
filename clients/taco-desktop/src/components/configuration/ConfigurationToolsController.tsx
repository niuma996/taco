import { useConfigurationScope } from "../../hooks/useConfigurationScope";
import { useToolsPane } from "../../hooks/useToolsPane";
import { ToolsPane } from "../../views/ToolsPane";
import {
    type ConfigurationControllerProps,
    ConfigurationPageLayout,
} from "./ConfigurationPageLayout";

export function ConfigurationToolsController(props: ConfigurationControllerProps) {
    const { active, client } = props;
    const configuration = useConfigurationScope(props);
    const tools = useToolsPane(client, active, configuration.targetCwd);

    if (!active) return null;
    return (
        <ConfigurationPageLayout {...props} variant="runtime" configuration={configuration}>
            <ToolsPane tools={tools.tools} error={tools.error} />
        </ConfigurationPageLayout>
    );
}
